import { describe, expect, it } from 'vitest'
import { measureSketchSelection } from '../../lib/sketch/measureSelection'
import type { SketchEntity } from '../../lib/sketch/types'

describe('sketch selection measurement', () => {
  it('reports line length, components, and angle without creating a dimension', () => {
    const line: SketchEntity = {
      id: 'line-1',
      kind: 'line',
      construction: false,
      start: { x: 1, y: 2 },
      end: { x: 4, y: 6 },
    }

    expect(measureSketchSelection([line], ['line-1'])).toEqual({
      title: 'Line',
      values: [
        { label: 'Length', value: 5, kind: 'length' },
        { label: 'dX', value: 3, kind: 'length' },
        { label: 'dY', value: 4, kind: 'length' },
        { label: 'Angle', value: expect.closeTo(53.130102, 5), kind: 'angle' },
      ],
    })
  })

  it('reports circle and arc size', () => {
    const entities: SketchEntity[] = [
      {
        id: 'circle-1',
        kind: 'circle',
        construction: false,
        center: { x: 0, y: 0 },
        radius: 4,
      },
      {
        id: 'arc-1',
        kind: 'arc',
        construction: false,
        center: { x: 0, y: 0 },
        radius: 2,
        startAngle: 0,
        endAngle: Math.PI / 2,
      },
    ]

    expect(measureSketchSelection(entities, ['circle-1'])?.values).toEqual([
      { label: 'Radius', value: 4, kind: 'length' },
      { label: 'Diameter', value: 8, kind: 'length' },
      { label: 'Circumference', value: 8 * Math.PI, kind: 'length' },
    ])
    expect(measureSketchSelection(entities, ['arc-1'])?.values).toEqual([
      { label: 'Radius', value: 2, kind: 'length' },
      { label: 'Arc length', value: Math.PI, kind: 'length' },
      { label: 'Sweep', value: 90, kind: 'angle' },
    ])
  })

  it('reports spacing between two natural reference points', () => {
    const entities: SketchEntity[] = [
      {
        id: 'point-1',
        kind: 'point',
        construction: false,
        at: { x: 2, y: 3 },
      },
      {
        id: 'circle-1',
        kind: 'circle',
        construction: false,
        center: { x: 8, y: 11 },
        radius: 1,
      },
    ]

    expect(measureSketchSelection(entities, ['point-1', 'circle-1'])).toEqual({
      title: 'Selection spacing',
      references: [
        { entityId: 'point-1', label: 'point' },
        { entityId: 'circle-1', label: 'circle center' },
      ],
      values: [
        { label: 'Distance', value: 10, kind: 'length' },
        { label: 'dX', value: 6, kind: 'length' },
        { label: 'dY', value: 8, kind: 'length' },
        { label: 'Angle', value: expect.closeTo(53.130102, 5), kind: 'angle' },
      ],
    })
  })

  it('returns no measurement for empty or ambiguous selections', () => {
    const entities: SketchEntity[] = [
      { id: 'a', kind: 'point', construction: false, at: { x: 0, y: 0 } },
      { id: 'b', kind: 'point', construction: false, at: { x: 1, y: 0 } },
      { id: 'c', kind: 'point', construction: false, at: { x: 2, y: 0 } },
    ]

    expect(measureSketchSelection(entities, [])).toBeNull()
    expect(measureSketchSelection(entities, ['a', 'b', 'c'])).toBeNull()
  })
})
