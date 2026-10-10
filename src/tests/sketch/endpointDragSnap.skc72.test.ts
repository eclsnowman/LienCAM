import { describe, expect, it } from 'vitest'
import {
  appendDragSnapConstraint,
  constraintForEndpointDragSnap,
  findEndpointDragSnap,
} from '../../lib/sketch/dragSnap'
import type { PointRef, Sketch, SketchEntity } from '../../lib/sketch/types'

const moving: PointRef = { entityId: 'moving', site: 'end' }
const entities: SketchEntity[] = [
  {
    id: 'moving', kind: 'line', construction: false,
    start: { x: 0, y: 0 }, end: { x: 5, y: 0 },
  },
  {
    id: 'target', kind: 'line', construction: false,
    start: { x: 10, y: 0 }, end: { x: 20, y: 0 },
  },
  {
    id: 'circle', kind: 'circle', construction: false,
    center: { x: 30, y: 0 }, radius: 5,
  },
]

function sketch(): Sketch {
  return {
    id: 'sketch', layerId: 'layer', entities,
    constraints: [], dimensions: [], solveStatus: null,
  }
}

describe('SKC-72 endpoint drag snapping', () => {
  it('prefers an addressable endpoint and commits one coincident constraint', () => {
    const target = findEndpointDragSnap(moving, { x: 10.2, y: 0.1 }, entities, 0.5)
    expect(target).toEqual({
      kind: 'point', point: { x: 10, y: 0 },
      ref: { entityId: 'target', site: 'start' },
    })
    const constraint = constraintForEndpointDragSnap(moving, target!, 'coincident-id')
    expect(constraint).toEqual({
      id: 'coincident-id', kind: 'coincident', a: moving,
      b: { entityId: 'target', site: 'start' },
    })
    const once = appendDragSnapConstraint(sketch(), constraint)
    const twice = appendDragSnapConstraint(once, { ...constraint, id: 'duplicate-id' })
    expect(twice.constraints).toEqual([constraint])
  })

  it('projects to a curve body and commits point-on-object', () => {
    const target = findEndpointDragSnap(moving, { x: 14, y: 0.2 }, entities, 0.5)
    expect(target).toEqual({ kind: 'curve', point: { x: 14, y: 0 }, entityId: 'target' })
    expect(constraintForEndpointDragSnap(moving, target!, 'point-line-id')).toEqual({
      id: 'point-line-id', kind: 'point_on_object', point: moving, object: 'target',
    })
  })

  it('snaps to circular geometry and returns null outside the acquisition radius', () => {
    expect(findEndpointDragSnap(moving, { x: 30, y: 5.2 }, entities, 0.5)).toEqual({
      kind: 'curve', point: { x: 30, y: 5 }, entityId: 'circle',
    })
    expect(findEndpointDragSnap(moving, { x: 30, y: 8 }, entities, 0.5)).toBeNull()
  })
})
