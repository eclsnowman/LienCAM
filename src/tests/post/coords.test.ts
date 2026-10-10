import { describe, it, expect } from 'vitest'
import { toWork, fixtureOffsetToP, g10Line } from '../../lib/post/coords'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { makeWcs } from './helpers'

describe('toWork', () => {
  it('subtracts the WCS origin (identity axes)', () => {
    const wcs = makeWcs({ origin: { x: 10, y: 20, z: -5 } })
    expect(toWork({ x: 12, y: 23, z: -2 }, wcs)).toEqual({ x: 2, y: 3, z: 3 })
  })

  it('is identity when origin is zero', () => {
    const wcs = makeWcs({ origin: { x: 0, y: 0, z: 0 } })
    expect(toWork({ x: 4, y: -7, z: 1.5 }, wcs)).toEqual({ x: 4, y: -7, z: 1.5 })
  })

  // WO-299: every case above uses identity axes (the default in makeWcs), so
  // the un-rotation math (the dot-product step against wcs.xAxis/yAxis/zAxis)
  // has never actually been exercised against a non-identity basis. This pins
  // exact numbers for a stated rotation - not "it differs from identity" -
  // because a test that only checked "differs" would still pass with the
  // basis-direction sign flipped, which is exactly the bug an audit (not a
  // test) caught in this feature's first draft (docs/research/
  // probing-angle-compensation.md).
  it('un-rotates by the WCS basis for a non-identity (90deg about Z) WCS', () => {
    // t = 90deg: xAxis = (cos t, -sin t, 0) = (0,-1,0), yAxis = (sin t, cos t, 0) = (1,0,0).
    const wcs = makeWcs({
      xAxis: { x: 0, y: -1, z: 0 },
      yAxis: { x: 1, y: 0, z: 0 },
      origin: { x: 10, y: 20, z: 0 },
    })
    // World point 100 along the part's local +X from the origin corner: delta
    // (100, 0, 0). x_work = xAxis.(100,0,0) = 0; y_work = yAxis.(100,0,0) = 100.
    expect(toWork({ x: 110, y: 20, z: 0 }, wcs)).toEqual({ x: 0, y: 100, z: 0 })
    // World point 100 along the part's local +Y: delta (0, 100, 0).
    // x_work = xAxis.(0,100,0) = -100; y_work = yAxis.(0,100,0) = 0.
    expect(toWork({ x: 10, y: 120, z: 0 }, wcs)).toEqual({ x: -100, y: 0, z: 0 })
  })
})

describe('fixtureOffsetToP', () => {
  it('maps G54..G59 to P1..P6', () => {
    expect(fixtureOffsetToP(54)).toBe(1)
    expect(fixtureOffsetToP(55)).toBe(2)
    expect(fixtureOffsetToP(59)).toBe(6)
  })
})

describe('g10Line', () => {
  it('builds a G10 L2 line with the P-number and origin coords', () => {
    const wcs = makeWcs({ fixtureOffset: 54, origin: { x: 10, y: 20, z: -3.5 } })
    expect(g10Line(wcs, UCCNC_CONFIG)).toBe('G10 L2 P1 X10 Y20 Z-3.5')
  })

  it('uses the dialect P-number for non-default offsets', () => {
    const wcs = makeWcs({ fixtureOffset: 56, origin: { x: 0, y: 0, z: 0 } })
    expect(g10Line(wcs, UCCNC_CONFIG)).toBe('G10 L2 P3 X0 Y0 Z0')
  })
})
