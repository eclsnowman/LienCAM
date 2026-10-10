import { describe, expect, it } from 'vitest'
import type { PlaneFrame } from '../../sketch3d/planeMath'
import { makeOffsetPlaneFrame } from '../../sketch3d/referencePlaneMath'

const XY: PlaneFrame = {
  origin: { x: 1, y: 2, z: 3 },
  normal: { x: 0, y: 0, z: 1 },
  xDir: { x: 1, y: 0, z: 0 },
}

describe('makeOffsetPlaneFrame', () => {
  it('moves along the parent normal and preserves a stable in-plane orientation', () => {
    const result = makeOffsetPlaneFrame(XY, 12.5)
    expect(result).toEqual({
      ok: true,
      frame: {
        origin: { x: 1, y: 2, z: 15.5 },
        normal: { x: 0, y: 0, z: 1 },
        xDir: { x: 1, y: 0, z: 0 },
      },
    })
  })

  it('flips orientation without moving the plane to the opposite offset', () => {
    const result = makeOffsetPlaneFrame(XY, 4, { flipNormal: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frame.origin).toEqual({ x: 1, y: 2, z: 7 })
    expect(result.frame.normal).toEqual({ x: 0, y: 0, z: -1 })
    expect(result.frame.xDir).toEqual({ x: 1, y: 0, z: 0 })
  })

  it.each([
    ['non-finite distance', XY, Number.NaN, 'non-finite-distance'],
    ['non-finite parent', { ...XY, origin: { x: Infinity, y: 0, z: 0 } }, 1, 'non-finite-parent-frame'],
    ['zero normal', { ...XY, normal: { x: 0, y: 0, z: 0 } }, 1, 'zero-parent-normal'],
    ['parallel xDir', { ...XY, xDir: { x: 0, y: 0, z: 2 } }, 1, 'degenerate-parent-xdir'],
  ] as const)('refuses %s instead of fabricating a frame', (_label, parent, distance, reason) => {
    expect(makeOffsetPlaneFrame(parent, distance)).toEqual({ ok: false, reason })
  })
})
