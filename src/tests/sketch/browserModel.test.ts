// Constraint browser list model (Stage 4 commit: browser panel).
//
// PURE headless tests: grouping by kind in display order, document-wide
// counts, entity labels ("Line 1" by per-kind document order), status
// mapping from the solve status (conflicting red wins over redundant
// amber), dimension value formatting (reference parenthesized, angles in
// degrees), and the solver-named-set row builder the resolution flow uses.

import { describe, it, expect } from 'vitest'
import {
  buildBrowserModel,
  entityLabels,
  rowsForIds,
} from '../../lib/sketch/browserModel'
import type {
  Sketch, SketchEntity, SketchConstraint, SketchDimension, SolveStatus,
} from '../../lib/sketch/types'

function line(id: string): SketchEntity {
  return { id, kind: 'line', construction: false,
    start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }
}
function circle(id: string): SketchEntity {
  return { id, kind: 'circle', construction: false,
    center: { x: 0, y: 0 }, radius: 5 }
}
function point(id: string): SketchEntity {
  return { id, kind: 'point', construction: false, at: { x: 0, y: 0 } }
}

function makeSketch(
  entities: SketchEntity[],
  constraints: SketchConstraint[] = [],
  dimensions: SketchDimension[] = [],
  solveStatus: SolveStatus | null = null,
): Sketch {
  return { id: 'sk', layerId: 'layer', entities, constraints, dimensions, solveStatus }
}

const fixtures = () => ({
  entities: [line('l1'), circle('c1'), line('l2'), point('p1')],
  constraints: [
    { id: 'cn-h1', kind: 'horizontal', line: 'l1' },
    { id: 'cn-h2', kind: 'horizontal', line: 'l2' },
    { id: 'cn-co', kind: 'coincident',
      a: { entityId: 'p1', site: 'self' },
      b: { entityId: 'c1', site: 'center' } },
    { id: 'cn-tan', kind: 'tangent', a: 'l1', b: 'c1' },
  ] as SketchConstraint[],
  dimensions: [
    { id: 'dm-w', kind: 'distance', driving: true, value: 10,
      a: { entityId: 'l1', site: 'start' }, b: { entityId: 'l1', site: 'end' } },
    { id: 'dm-r', kind: 'radius', driving: false, value: 5, entityId: 'c1' },
    { id: 'dm-a', kind: 'angle', driving: true, value: Math.PI / 2,
      a: 'l1', b: 'l2' },
  ] as SketchDimension[],
})

describe('entityLabels', () => {
  it('labels per kind in document order', () => {
    const labels = entityLabels(fixtures().entities)
    expect(labels.get('l1')).toBe('Line 1')
    expect(labels.get('c1')).toBe('Circle 1')
    expect(labels.get('l2')).toBe('Line 2')
    expect(labels.get('p1')).toBe('Point 1')
  })
})

describe('buildBrowserModel grouping', () => {
  it('groups by kind in fixed display order, constraints before dims', () => {
    const f = fixtures()
    const model = buildBrowserModel(
      makeSketch(f.entities, f.constraints, f.dimensions), null)
    expect(model.groups.map((g) => g.kind)).toEqual([
      'coincident', 'horizontal', 'tangent',   // toolbox kind order
      'distance', 'angle', 'radius',           // dimension kind order
    ])
    const horizontal = model.groups.find((g) => g.kind === 'horizontal')!
    expect(horizontal.rows.map((r) => r.id)).toEqual(['cn-h1', 'cn-h2'])
    expect(model.constraintCount).toBe(4)
    expect(model.dimensionCount).toBe(3)
  })

  it('renders operand entity labels, never raw ids', () => {
    const f = fixtures()
    const model = buildBrowserModel(
      makeSketch(f.entities, f.constraints, f.dimensions), null)
    const coincident = model.groups.find((g) => g.kind === 'coincident')!
    expect(coincident.rows[0].operands).toBe('Point 1, Circle 1')
    const tangent = model.groups.find((g) => g.kind === 'tangent')!
    expect(tangent.rows[0].operands).toBe('Line 1, Circle 1')
    for (const g of model.groups) {
      for (const r of g.rows) {
        expect(r.operands).not.toMatch(/cn-|dm-|l1|c1/)
      }
    }
  })

  it('formats dimension values: driving plain, reference parenthesized, angle in degrees', () => {
    const f = fixtures()
    const model = buildBrowserModel(
      makeSketch(f.entities, f.constraints, f.dimensions), null)
    const dist = model.groups.find((g) => g.kind === 'distance')!.rows[0]
    expect(dist.operands).toBe('Line 1 = 10 mm')
    expect(dist.isDimension).toBe(true)
    expect(dist.reference).toBe(false)
    const rad = model.groups.find((g) => g.kind === 'radius')!.rows[0]
    expect(rad.operands).toBe('Circle 1 = (5 mm)')
    expect(rad.reference).toBe(true)
    const ang = model.groups.find((g) => g.kind === 'angle')!.rows[0]
    expect(ang.operands).toBe('Line 1, Line 2 = 90 deg')
  })

  it('drops empty groups', () => {
    const model = buildBrowserModel(makeSketch([line('l1')]), null)
    expect(model.groups).toEqual([])
    expect(model.constraintCount).toBe(0)
    expect(model.dimensionCount).toBe(0)
  })
})

describe('buildBrowserModel status mapping', () => {
  it('maps conflicting red / redundant amber from the solve status', () => {
    const f = fixtures()
    const status: SolveStatus = {
      dof: 0,
      conflicting: ['cn-h1', 'dm-w'],
      redundant: ['cn-h2'],
    }
    const model = buildBrowserModel(
      makeSketch(f.entities, f.constraints, f.dimensions), status)
    const byId = new Map(
      model.groups.flatMap((g) => g.rows).map((r) => [r.id, r]))
    expect(byId.get('cn-h1')!.status).toBe('conflicting')
    expect(byId.get('dm-w')!.status).toBe('conflicting')
    expect(byId.get('cn-h2')!.status).toBe('redundant')
    expect(byId.get('cn-co')!.status).toBe('ok')
    expect(model.conflictingCount).toBe(2)
    expect(model.redundantCount).toBe(1)
  })

  it('conflicting wins when an id is named in both sets', () => {
    const f = fixtures()
    const status: SolveStatus = {
      dof: 0, conflicting: ['cn-h1'], redundant: ['cn-h1'],
    }
    const model = buildBrowserModel(
      makeSketch(f.entities, f.constraints, f.dimensions), status)
    const row = model.groups.flatMap((g) => g.rows).find((r) => r.id === 'cn-h1')!
    expect(row.status).toBe('conflicting')
    expect(model.conflictingCount).toBe(1)
    expect(model.redundantCount).toBe(0)
  })

  it('null status (never solved) flags nothing', () => {
    const f = fixtures()
    const model = buildBrowserModel(
      makeSketch(f.entities, f.constraints, f.dimensions), null)
    expect(model.groups.flatMap((g) => g.rows)
      .every((r) => r.status === 'ok')).toBe(true)
    expect(model.conflictingCount).toBe(0)
    expect(model.redundantCount).toBe(0)
  })
})

describe('rowsForIds (solver-named sets, resolution flow)', () => {
  it('builds rows in the solver order, mixing constraints and dimensions', () => {
    const f = fixtures()
    const sk = makeSketch(f.entities, f.constraints, f.dimensions)
    const rows = rowsForIds(sk, ['dm-w', 'cn-h1'])
    expect(rows.map((r) => r.id)).toEqual(['dm-w', 'cn-h1'])
    expect(rows[0].isDimension).toBe(true)
    expect(rows[0].operands).toBe('Line 1 = 10 mm')
    expect(rows[1].label).toBe('Horizontal')
  })

  it('drops ids that match nothing in the document (stale status)', () => {
    const f = fixtures()
    const sk = makeSketch(f.entities, f.constraints, f.dimensions)
    const rows = rowsForIds(sk, ['cn-h1', 'gone-id'])
    expect(rows.map((r) => r.id)).toEqual(['cn-h1'])
  })
})
