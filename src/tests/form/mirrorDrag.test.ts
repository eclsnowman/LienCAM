// Form: dragging the mirror plane - the pointer's ray read as a slide along the plane's normal.

import { describe, expect, it } from 'vitest'
import { slideAlongNormal, slidMirrorAt } from '../../form/mirrorDrag'

describe('slideAlongNormal', () => {
  it('a ray across the normal line reads where it crosses: a camera on -Y looking +Y, the plane grabbed at x = 0 with normal +X', () => {
    // the pointer moved to x = 12: the ray passes the line (0,0,5)+t(1,0,0) closest at t = 12
    expect(slideAlongNormal([12, -100, 5], [0, 1, 0], [0, 0, 5], [1, 0, 0])).toBeCloseTo(12, 9)
    expect(slideAlongNormal([-3.5, -100, 40], [0, 1, 0], [0, 0, 5], [1, 0, 0])).toBeCloseTo(-3.5, 9)
  })

  it('an oblique view reads the same slide: only the part of the pointer movement along the normal counts', () => {
    const dir: [number, number, number] = [0, 1, -1]
    // a ray through (7, 0, 5) seen from above and in front
    expect(slideAlongNormal([7, -50, 55], dir, [0, 0, 5], [1, 0, 0])).toBeCloseTo(7, 9)
    // a normal given un-normalized reads the same
    expect(slideAlongNormal([7, -50, 55], dir, [0, 0, 5], [3, 0, 0])).toBeCloseTo(7, 9)
  })

  it('looking straight along the normal there is nothing to read: null, the plane stays put', () => {
    expect(slideAlongNormal([0, 0, 50], [0, 0, -1], [0, 0, 5], [0, 0, 1])).toBeNull()
  })
})

describe('slidMirrorAt', () => {
  it('adds the slide to where the plane was grabbed, to 0.01 mm', () => {
    expect(slidMirrorAt(10, 2.345678)).toBe(12.35)
    expect(slidMirrorAt(-4, 1.001)).toBe(-3)
  })
})
