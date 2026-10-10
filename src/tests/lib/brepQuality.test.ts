// B-rep render-fidelity tier table (quality.ts). PURE module: no OCCT/worker
// imports, so this runs as a plain unit test. Locks the exact deflection values
// each named tier maps to, the default tier, and the unknown -> balanced guard.
import { describe, it, expect } from 'vitest'
import {
  deflectionForQuality,
  DEFAULT_BREP_QUALITY,
} from '../../lib/cam/geometry/occt/model/quality'
import type { BrepTessellationQuality } from '../../types'

describe('deflectionForQuality', () => {
  it('maps each tier to its exact (linear, angular) deflection', () => {
    expect(deflectionForQuality('performance')).toEqual({
      linearDeflection: 0.1,
      angularDeflection: 0.5,
    })
    expect(deflectionForQuality('balanced')).toEqual({
      linearDeflection: 0.05,
      angularDeflection: 0.25,
    })
    expect(deflectionForQuality('high')).toEqual({
      linearDeflection: 0.025,
      angularDeflection: 0.12,
    })
  })

  it('defaults to balanced', () => {
    expect(DEFAULT_BREP_QUALITY).toBe('balanced')
    expect(deflectionForQuality(DEFAULT_BREP_QUALITY)).toEqual({
      linearDeflection: 0.05,
      angularDeflection: 0.25,
    })
  })

  it('falls back to balanced for an unknown tier', () => {
    const bogus = 'ultra' as unknown as BrepTessellationQuality
    expect(deflectionForQuality(bogus)).toEqual(deflectionForQuality('balanced'))
  })
})
