import { describe, expect, it } from 'vitest'
import { fmtDim, fmtMachineLength, fromDisplay, toDisplay } from '../../lib/ui/unitFormat'

describe('WO-2702 rounded negative zero is presentation only', () => {
  it.each([
    [-0.0004, 'mm', '0.00'], [-0, 'mm', '0.00'], [0, 'mm', '0.00'],
    [-0.0051, 'mm', '-0.01'], [-0.0004, 'inch', '0.000'], [-0.02, 'inch', '-0.001'],
  ] as const)('formats machine length %s in %s as %s', (mm, units, expected) => {
    expect(fmtMachineLength(mm, units)).toBe(expected)
    expect(fromDisplay(toDisplay(mm, units), units)).toBe(mm)
  })
  it('normalizes only a rounded zero at the chosen dimension precision', () => {
    expect(fmtDim(-0.00004, 'mm')).toBe('0.000')
    expect(fmtDim(-0.0004, 'mm', 2)).toBe('0.00')
    expect(fmtDim(-0.0004, 'mm', 4)).toBe('-0.0004')
    expect(fmtDim(-1.2345, 'mm', 2)).toBe('-1.23')
    expect(fmtDim(NaN, 'mm')).toBe('NaN')
    expect(fmtDim(-Infinity, 'mm')).toBe('-Infinity')
  })
})
