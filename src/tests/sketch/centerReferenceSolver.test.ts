import { describe, expect, it } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type {
  PointRef,
  Sketch,
  SketchConstraint,
  SketchDimension,
  SketchEntity,
} from '../../lib/sketch/types'

const ref = (entityId: string, site: PointRef['site']): PointRef => ({ entityId, site })

function line(
  id: string,
  start: [number, number],
  end: [number, number],
): SketchEntity {
  return {
    id, kind: 'line', construction: false,
    start: { x: start[0], y: start[1] },
    end: { x: end[0], y: end[1] },
  }
}

function circle(id: string, x: number, y: number, radius: number): SketchEntity {
  return {
    id, kind: 'circle', construction: false,
    center: { x, y }, radius,
  }
}

function point(id: string, x: number, y: number): SketchEntity {
  return { id, kind: 'point', construction: false, at: { x, y } }
}

function sketch(
  entities: SketchEntity[],
  constraints: SketchConstraint[] = [],
  dimensions: SketchDimension[] = [],
): Sketch {
  return {
    id: 'sk', layerId: 'layer', entities, constraints, dimensions,
    solveStatus: null,
  }
}

function solvedCircle(entities: SketchEntity[], id: string) {
  const entity = entities.find((candidate) => candidate.id === id)
  if (!entity || entity.kind !== 'circle') throw new Error(`missing circle '${id}'`)
  return entity
}

function solvedLine(entities: SketchEntity[], id: string) {
  const entity = entities.find((candidate) => candidate.id === id)
  if (!entity || entity.kind !== 'line') throw new Error(`missing line '${id}'`)
  return entity
}

describe('SKC-62 center-reference solver behavior', () => {
  it('editing center-to-line-endpoint distance moves the circle without radius drift', async () => {
    const gcs = await createGcsWrapper()
    const base = sketch(
      [line('line', [0, 0], [10, 0]), circle('circle', 20, 0, 5)],
      [{ id: 'fix-line', kind: 'fix', entityId: 'line' }],
      [{
        id: 'distance', kind: 'distance', driving: true, value: 20,
        a: ref('line', 'start'), b: ref('circle', 'center'),
      }],
    )
    const first = solveSketchOnWrapper(gcs, base)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const before = solvedCircle(first.entities, 'circle')
    expect(before.radius).toBeCloseTo(5, 9)
    expect(Math.hypot(before.center.x, before.center.y)).toBeCloseTo(20, 6)

    const edited: Sketch = {
      ...base,
      entities: first.entities,
      dimensions: [{ ...base.dimensions[0], value: 30 }],
    }
    const second = solveSketchOnWrapper(gcs, edited)
    expect(second.ok).toBe(true)
    if (second.ok) {
      const after = solvedCircle(second.entities, 'circle')
      expect(Math.hypot(after.center.x, after.center.y)).toBeCloseTo(30, 5)
      expect(after.radius).toBeCloseTo(5, 9)
    }
    gcs.destroy_gcs_module()
  })

  it('editing center-to-center horizontal distance moves only the free owner', async () => {
    const gcs = await createGcsWrapper()
    const base = sketch(
      [circle('fixed', 0, 10, 3), circle('moving', 20, 10, 7)],
      [
        { id: 'fix-center', kind: 'fix', point: ref('fixed', 'center') },
        {
          id: 'align', kind: 'horizontal',
          points: [ref('fixed', 'center'), ref('moving', 'center')],
        },
      ],
      [{
        id: 'dx', kind: 'distanceX', driving: true, value: 20,
        a: ref('fixed', 'center'), b: ref('moving', 'center'),
      }],
    )
    const first = solveSketchOnWrapper(gcs, base)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const edited: Sketch = {
      ...base,
      entities: first.entities,
      dimensions: [{ ...base.dimensions[0], value: 35 }],
    }
    const second = solveSketchOnWrapper(gcs, edited)
    expect(second.ok).toBe(true)
    if (second.ok) {
      const fixed = solvedCircle(second.entities, 'fixed')
      const moving = solvedCircle(second.entities, 'moving')
      expect(fixed.center).toEqual({ x: 0, y: 10 })
      expect(moving.center.x - fixed.center.x).toBeCloseTo(35, 6)
      expect(moving.center.y).toBeCloseTo(fixed.center.y, 6)
      expect(moving.radius).toBeCloseTo(7, 9)
      expect(fixed.radius).toBeCloseTo(3, 9)
    }
    gcs.destroy_gcs_module()
  })

  it('constrains the derived line center without a persisted free point', async () => {
    const gcs = await createGcsWrapper()
    const base = sketch(
      [point('origin', 0, 0), line('line', [10, -5], [20, 5])],
      [
        { id: 'fix-origin', kind: 'fix', point: ref('origin', 'self') },
        {
          id: 'align', kind: 'horizontal',
          points: [ref('origin', 'self'), ref('line', 'center')],
        },
      ],
      [{
        id: 'dx', kind: 'distanceX', driving: true, value: 25,
        a: ref('origin', 'self'), b: ref('line', 'center'),
      }],
    )
    const out = solveSketchOnWrapper(gcs, base)
    expect(out.ok).toBe(true)
    if (out.ok) {
      const result = solvedLine(out.entities, 'line')
      const center = {
        x: (result.start.x + result.end.x) / 2,
        y: (result.start.y + result.end.y) / 2,
      }
      expect(center.x).toBeCloseTo(25, 6)
      expect(center.y).toBeCloseTo(0, 6)
      expect(out.entities).toHaveLength(2)
    }
    gcs.destroy_gcs_module()
  })

  it('uses the same center semantics for coincident and concentric', async () => {
    const gcs = await createGcsWrapper()
    const coincident = solveSketchOnWrapper(gcs, sketch(
      [point('anchor', 4, -3), circle('circle', 20, 20, 5)],
      [
        { id: 'fix-anchor', kind: 'fix', point: ref('anchor', 'self') },
        {
          id: 'coincident', kind: 'coincident',
          a: ref('anchor', 'self'), b: ref('circle', 'center'),
        },
      ],
    ))
    expect(coincident.ok).toBe(true)
    if (coincident.ok) {
      expect(solvedCircle(coincident.entities, 'circle').center)
        .toEqual({ x: 4, y: -3 })
    }

    const concentric = solveSketchOnWrapper(gcs, sketch(
      [circle('fixed', 2, 6, 3), circle('moving', 20, 10, 8)],
      [
        { id: 'fix-center', kind: 'fix', point: ref('fixed', 'center') },
        { id: 'concentric', kind: 'concentric', a: 'fixed', b: 'moving' },
      ],
    ))
    expect(concentric.ok).toBe(true)
    if (concentric.ok) {
      const moving = solvedCircle(concentric.entities, 'moving')
      expect(moving.center.x).toBeCloseTo(2, 6)
      expect(moving.center.y).toBeCloseTo(6, 6)
      expect(moving.radius).toBeCloseTo(8, 9)
    }
    gcs.destroy_gcs_module()
  })

  it('fails loud on a conflicting fixed-center coincidence and leaves input unchanged', async () => {
    const gcs = await createGcsWrapper()
    const input = sketch(
      [point('anchor', 0, 0), circle('circle', 10, 0, 5)],
      [
        { id: 'fix-anchor', kind: 'fix', point: ref('anchor', 'self') },
        { id: 'fix-circle', kind: 'fix', point: ref('circle', 'center') },
        {
          id: 'conflicting-coincident', kind: 'coincident',
          a: ref('anchor', 'self'), b: ref('circle', 'center'),
        },
      ],
    )
    const before = JSON.parse(JSON.stringify(input.entities))
    const out = solveSketchOnWrapper(gcs, input)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.reason).toBe('conflicting')
      expect(out.status.conflicting.length).toBeGreaterThan(0)
    }
    expect(input.entities).toEqual(before)
    gcs.destroy_gcs_module()
  })
})
