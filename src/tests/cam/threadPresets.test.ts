import { describe, it, expect } from 'vitest'
import {
  THREAD_PRESETS,
  THREAD_STANDARDS,
  findThreadPreset,
  findThreadByMajor,
  findThreadByBore,
} from '../../lib/cam/threadPresets'

describe('thread-size presets table', () => {
  it('is non-empty', () => {
    expect(THREAD_PRESETS.length).toBeGreaterThan(0)
  })

  it('M10x1.5 has majorDiameter 10 and pitch 1.5', () => {
    const m10 = findThreadPreset('M10x1.5')
    expect(m10).toBeDefined()
    expect(m10!.majorDiameter).toBe(10)
    expect(m10!.pitch).toBe(1.5)
  })

  it('a UNC entry derives pitch == 25.4 / tpi', () => {
    const unc = findThreadPreset('3/8-16-UNC')
    expect(unc).toBeDefined()
    expect(unc!.tpi).toBe(16)
    expect(unc!.pitch).toBeCloseTo(25.4 / 16, 12)
    expect(Math.abs(unc!.pitch - 25.4 / 16)).toBeLessThan(1e-9)
  })

  it('findThreadPreset returns undefined for unknown / empty id', () => {
    expect(findThreadPreset('')).toBeUndefined()
    expect(findThreadPreset('nope')).toBeUndefined()
  })

  // ── curated dropdown list must remain unchanged ──
  it('THREAD_PRESETS curated dropdown is unchanged (length + ids/order)', () => {
    expect(THREAD_PRESETS.length).toBe(16)
    expect(THREAD_PRESETS.map(p => p.id)).toEqual([
      'M3x0.5', 'M4x0.7', 'M5x0.8', 'M6x1.0', 'M8x1.25', 'M10x1.5',
      'M12x1.75', 'M16x2.0', 'M20x2.5', 'M24x3.0',
      '1/4-20-UNC', '5/16-18-UNC', '3/8-16-UNC', '1/2-13-UNC',
      '1/4-28-UNF', '3/8-24-UNF',
    ])
    // dropdown still resolves via findThreadPreset
    expect(findThreadPreset('M10x1.5')).toBeDefined()
  })
})

describe('THREAD_STANDARDS snap table', () => {
  it('tap-drill follows the major - pitch rule exactly for key sizes', () => {
    const m10 = THREAD_STANDARDS.find(t => t.id === 'M10x1.5')!
    const m6 = THREAD_STANDARDS.find(t => t.id === 'M6x1.0')!
    const m16 = THREAD_STANDARDS.find(t => t.id === 'M16x2.0')!
    expect(m10.tapDrill).toBe(8.5)
    expect(m6.tapDrill).toBe(5.0)
    expect(m16.tapDrill).toBe(14.0)
  })
})

describe('findThreadByMajor (boss OD -> thread)', () => {
  it('16.0 -> M16x2.0 coarse (major 16, pitch 2, coarsest on tie)', () => {
    const t = findThreadByMajor(16.0)
    expect(t).toBeDefined()
    expect(t!.majorDiameter).toBe(16)
    expect(t!.pitch).toBe(2)
    expect(t!.id).toBe('M16x2.0')
  })

  it('6.0 -> M6 coarse', () => {
    const t = findThreadByMajor(6.0)
    expect(t).toBeDefined()
    expect(t!.id).toBe('M6x1.0')
    expect(t!.majorDiameter).toBe(6)
  })

  it('99 -> undefined (nothing within tolerance)', () => {
    expect(findThreadByMajor(99)).toBeUndefined()
  })

  it('respects the tolerance window', () => {
    // 10.3 is 0.3 from M10 -> inside default 0.4 tol
    expect(findThreadByMajor(10.3)!.majorDiameter).toBe(10)
    // ...but outside a tight 0.1 tol
    expect(findThreadByMajor(10.3, 0.1)).toBeUndefined()
  })
})

describe('findThreadByBore (tap-drill hole -> thread)', () => {
  it('8.5 -> M10x1.5 (major 10, pitch 1.5)', () => {
    const t = findThreadByBore(8.5)
    expect(t).toBeDefined()
    expect(t!.majorDiameter).toBe(10)
    expect(t!.pitch).toBe(1.5)
    expect(t!.id).toBe('M10x1.5')
  })

  it('5.0 -> M6x1.0', () => {
    const t = findThreadByBore(5.0)
    expect(t).toBeDefined()
    expect(t!.id).toBe('M6x1.0')
    expect(t!.majorDiameter).toBe(6)
  })

  it('99 -> undefined (nothing within tolerance)', () => {
    expect(findThreadByBore(99)).toBeUndefined()
  })
})
