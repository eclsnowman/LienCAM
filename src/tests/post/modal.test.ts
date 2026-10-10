import { describe, it, expect } from 'vitest'
import { createModalState } from '../../lib/post/modal'

describe('createModalState', () => {
  it('emits all coords on the first block', () => {
    const m = createModalState()
    expect(m.coordWords(1, 2, 3, 3, 'mm')).toEqual(['X1', 'Y2', 'Z3'])
  })

  it('suppresses unchanged coord words and emits only changed ones', () => {
    const m = createModalState()
    m.coordWords(1, 2, 3, 3, 'mm')
    // Only X changes.
    expect(m.coordWords(5, 2, 3, 3, 'mm')).toEqual(['X5'])
    // Nothing changes -> empty.
    expect(m.coordWords(5, 2, 3, 3, 'mm')).toEqual([])
    // Y and Z change.
    expect(m.coordWords(5, 9, 8, 3, 'mm')).toEqual(['Y9', 'Z8'])
  })

  it('inch converts coords (mm/25.4) at the formatting seam; dedup stays on mm', () => {
    const m = createModalState()
    // 25.4 mm -> 1.0000 in; 50.8 -> 2.0000; 12.7 -> 0.5000 (xyz 4 decimals).
    expect(m.coordWords(25.4, 50.8, 12.7, 4, 'inch')).toEqual(['X1', 'Y2', 'Z0.5'])
    // Dedup is on the canonical mm value: same mm -> nothing emitted.
    expect(m.coordWords(25.4, 50.8, 12.7, 4, 'inch')).toEqual([])
  })

  it('emits the motion word only on change', () => {
    const m = createModalState()
    expect(m.motionWord('G0')).toBe('G0')
    expect(m.motionWord('G0')).toBeNull()
    expect(m.motionWord('G1')).toBe('G1')
    expect(m.motionWord('G1')).toBeNull()
  })

  it('emits the feed word only on change', () => {
    const m = createModalState()
    expect(m.feedWord(2000, 1, 'mm')).toBe('F2000')
    expect(m.feedWord(2000, 1, 'mm')).toBeNull()
    expect(m.feedWord(1000, 1, 'mm')).toBe('F1000')
  })

  it('inch converts the feed (mm/min -> IPM, /25.4)', () => {
    const m = createModalState()
    // 1500 mm/min -> 59.0551... IPM at 1 decimal -> F59.1.
    expect(m.feedWord(1500, 1, 'inch')).toBe('F59.1')
  })

  it('emits the speed word only on change', () => {
    const m = createModalState()
    expect(m.speedWord(12000)).toBe('S12000')
    expect(m.speedWord(12000)).toBeNull()
    expect(m.speedWord(18000)).toBe('S18000')
  })

  it('forceReset re-emits everything', () => {
    const m = createModalState()
    m.coordWords(1, 2, 3, 3, 'mm')
    m.motionWord('G1')
    m.feedWord(2000, 1, 'mm')
    m.speedWord(12000)
    m.forceReset()
    expect(m.coordWords(1, 2, 3, 3, 'mm')).toEqual(['X1', 'Y2', 'Z3'])
    expect(m.motionWord('G1')).toBe('G1')
    expect(m.feedWord(2000, 1, 'mm')).toBe('F2000')
    expect(m.speedWord(12000)).toBe('S12000')
  })
})
