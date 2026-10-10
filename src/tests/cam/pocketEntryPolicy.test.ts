import { describe, expect, it } from 'vitest'
import {
  assertPocketEntryAllowed,
  getDefaultPocketEntry,
  getPocketEntryPolicy,
  normalizePocketEntryForFillStrategy,
  POCKET_ENTRY_LABELS,
} from '../../lib/cam/pocketEntryPolicy'

describe('Pocket 2D entry compatibility policy', () => {
  it('defaults outside-in pockets to Profile Ramp and permits Plunge', () => {
    expect(getPocketEntryPolicy('outside_in')).toEqual({
      allowed: ['ramp_linear', 'plunge'],
      defaultEntry: 'ramp_linear',
    })
    expect(getDefaultPocketEntry(undefined)).toBe('ramp_linear')
    expect(POCKET_ENTRY_LABELS.ramp_linear).toBe('Profile Ramp')
  })

  it('defaults inside-out pockets to Helix and permits Plunge', () => {
    expect(getPocketEntryPolicy('inside_out')).toEqual({
      allowed: ['ramp_helical', 'plunge'],
      defaultEntry: 'ramp_helical',
    })
  })

  it('normalizes only explicit fill-strategy transitions to their default', () => {
    expect(normalizePocketEntryForFillStrategy('outside_in', 'ramp_helical')).toBe('ramp_linear')
    expect(normalizePocketEntryForFillStrategy('inside_out', 'ramp_linear')).toBe('ramp_helical')
    expect(normalizePocketEntryForFillStrategy('outside_in', 'plunge')).toBe('plunge')
  })

  it('rejects incompatible and unsupported entry combinations loudly', () => {
    expect(() => assertPocketEntryAllowed('outside_in', 'ramp_helical'))
      .toThrow(/not compatible with outside_in.*Profile Ramp or Plunge/)
    expect(() => assertPocketEntryAllowed('inside_out', 'ramp_linear'))
      .toThrow(/not compatible with inside_out.*Helix or Plunge/)
    expect(() => assertPocketEntryAllowed('outside_in', 'arc'))
      .toThrow(/not compatible/)
  })
})
