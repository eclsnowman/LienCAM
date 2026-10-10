import { describe, expect, it } from 'vitest'
import type { Sketch3dDocument } from '../../sketch3d'
import { pickEntity, pickPoint } from '../../components/sketch3dlab/picking'

function doc(): Sketch3dDocument {
  return {
    id: 'd',
    entities: [
      { id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'c1', kind: 'circle', center: { x: 20, y: 0 }, radius: 4 },
      { id: 'a1', kind: 'arc', center: { x: 0, y: 20 }, radius: 5, startAngle: 0, endAngle: Math.PI / 2 },
    ],
    constraints: [],
  }
}

describe('sketch3dlab picking', () => {
  it('pickPoint finds a line endpoint within tolerance', () => {
    const ref = pickPoint(doc(), { x: 0.1, y: 0.1 })
    expect(ref).toEqual({ entityId: 'l1', site: 'start' })
  })

  it('pickPoint finds a circle center', () => {
    const ref = pickPoint(doc(), { x: 20.05, y: -0.1 })
    expect(ref).toEqual({ entityId: 'c1', site: 'center' })
  })

  it('pickPoint returns null when nothing is within tolerance', () => {
    expect(pickPoint(doc(), { x: 5, y: 5 })).toBeNull()
  })

  it('pickEntity finds a line by mid-segment click, away from its endpoints', () => {
    expect(pickEntity(doc(), { x: 5, y: 0.05 })).toBe('l1')
  })

  it('pickEntity finds a circle by its ring, not its interior', () => {
    expect(pickEntity(doc(), { x: 24, y: 0 })).toBe('c1')
    expect(pickEntity(doc(), { x: 20, y: 0 })).toBeNull() // dead center, off the ring
  })

  it('pickEntity finds an arc by its ring', () => {
    expect(pickEntity(doc(), { x: 5, y: 20 })).toBe('a1')
  })

  it('pickEntity returns null when nothing is within tolerance', () => {
    expect(pickEntity(doc(), { x: 100, y: 100 })).toBeNull()
  })
})
