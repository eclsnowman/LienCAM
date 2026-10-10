// Pure interior hit-test for loop picking (drill-hole center clicks).
import { describe, it, expect } from 'vitest'
import { rayPiercesClosedLoop, type V3 } from '../../lib/viewport/loopPickInterior'

// A unit square in the world XY plane at z=0, centered on (5,5).
const squareXY: V3[] = [
  { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 },
  { x: 10, y: 10, z: 0 }, { x: 0, y: 10, z: 0 },
  { x: 0, y: 0, z: 0 },   // closing duplicate (as the viewport appends)
]
const down: V3 = { x: 0, y: 0, z: -1 }   // ray pointing -Z (top-down view)

describe('rayPiercesClosedLoop', () => {
  it('a top-down ray through the CENTER pierces the loop (returns its area)', () => {
    const area = rayPiercesClosedLoop(squareXY, { x: 5, y: 5, z: 50 }, down)
    expect(area).not.toBeNull()
    expect(area!).toBeCloseTo(100, 6)
  })

  it('a ray OUTSIDE the loop footprint does not pierce it', () => {
    expect(rayPiercesClosedLoop(squareXY, { x: 20, y: 20, z: 50 }, down)).toBeNull()
  })

  it('intersection BEHIND the camera (t < 0) does not count', () => {
    // Origin below the plane, ray still pointing down -> plane is behind it.
    expect(rayPiercesClosedLoop(squareXY, { x: 5, y: 5, z: -50 }, down)).toBeNull()
  })

  it('a ray PARALLEL to the loop plane does not pierce it', () => {
    expect(rayPiercesClosedLoop(squareXY, { x: 5, y: 5, z: 50 }, { x: 1, y: 0, z: 0 })).toBeNull()
  })

  it('smaller loop reports a smaller area (caller picks the innermost = smallest)', () => {
    const inner: V3[] = [
      { x: 4, y: 4, z: 0 }, { x: 6, y: 4, z: 0 },
      { x: 6, y: 6, z: 0 }, { x: 4, y: 6, z: 0 }, { x: 4, y: 4, z: 0 },
    ]
    const big = rayPiercesClosedLoop(squareXY, { x: 5, y: 5, z: 50 }, down)
    const small = rayPiercesClosedLoop(inner, { x: 5, y: 5, z: 50 }, down)
    expect(big).not.toBeNull()
    expect(small).not.toBeNull()
    expect(small!).toBeLessThan(big!)
    expect(small!).toBeCloseTo(4, 6)
  })

  it('works on a TILTED plane (a hole on an angled face)', () => {
    // Square in a plane tilted 45deg about the X axis; shoot a ray down its normal.
    const s = Math.SQRT1_2
    const tilted: V3[] = [
      { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 },
      { x: 10, y: 10 * s, z: 10 * s }, { x: 0, y: 10 * s, z: 10 * s },
      { x: 0, y: 0, z: 0 },
    ]
    // Center of the tilted square, shoot along -normal (normal ~ (0,-s,s)).
    const center: V3 = { x: 5, y: 5 * s, z: 5 * s }
    const along: V3 = { x: 0, y: s, z: -s }   // toward the plane from above
    const origin: V3 = { x: center.x - along.x * 50, y: center.y - along.y * 50, z: center.z - along.z * 50 }
    const area = rayPiercesClosedLoop(tilted, origin, along)
    expect(area).not.toBeNull()
    expect(area!).toBeCloseTo(100, 4)
  })

  it('degenerate loop (<3 points) returns null', () => {
    expect(rayPiercesClosedLoop([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], { x: 0, y: 0, z: 1 }, down)).toBeNull()
  })
})
