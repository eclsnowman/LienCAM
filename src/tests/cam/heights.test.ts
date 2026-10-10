import { describe, it, expect } from 'vitest'
import { resolveHeights } from '../../lib/cam/heights'

const BASE_HEIGHTS = {
  clearanceHeight:     10,
  clearanceHeightMode: 'absolute' as const,
  retractHeight:        5,
  feedHeight:           1,
  topHeight:            0,
  topHeightMode:       'stock_top' as const,
  bottomHeight:        -5,
  bottomHeightMode:    'absolute' as const,
}

describe('resolveHeights', () => {
  it('wcsOrigin.z = 0: all outputs equal the corresponding input field', () => {
    const result = resolveHeights(BASE_HEIGHTS, { x: 0, y: 0, z: 0 })
    expect(result.clearanceZ).toBe(10)
    expect(result.retractZ).toBe(5)
    expect(result.feedZ).toBe(1)
    expect(result.topZ).toBe(0)
    expect(result.bottomZ).toBe(-5)
  })

  it('wcsOrigin.z = 10: all outputs equal input + 10', () => {
    const result = resolveHeights(BASE_HEIGHTS, { x: 0, y: 0, z: 10 })
    expect(result.clearanceZ).toBe(20)
    expect(result.retractZ).toBe(15)
    expect(result.feedZ).toBe(11)
    expect(result.topZ).toBe(10)
    expect(result.bottomZ).toBe(5)
  })

  it('wcsOrigin.z = -5: all outputs equal input - 5', () => {
    const result = resolveHeights(BASE_HEIGHTS, { x: 0, y: 0, z: -5 })
    expect(result.clearanceZ).toBe(5)
    expect(result.retractZ).toBe(0)
    expect(result.feedZ).toBe(-4)
    expect(result.topZ).toBe(-5)
    expect(result.bottomZ).toBe(-10)
  })
})
