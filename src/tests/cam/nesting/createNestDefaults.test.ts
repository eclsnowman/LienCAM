import { describe, it, expect } from 'vitest'
import {
  buildCreateNestParams,
  CREATE_NEST_TEST_DEFAULTS,
} from '../../../lib/cam/nesting/createNestDefaults'

describe('buildCreateNestParams (P3.4 temporary test trigger)', () => {
  it('returns null when no parts are selected', () => {
    expect(buildCreateNestParams([])).toBeNull()
    expect(buildCreateNestParams([''])).toBeNull()
  })

  it('maps each selected id to a source with the default quantity', () => {
    const params = buildCreateNestParams(['a', 'b'])
    expect(params).not.toBeNull()
    expect(params!.sources).toEqual([
      { geometryId: 'a', quantity: CREATE_NEST_TEST_DEFAULTS.quantityPerPart },
      { geometryId: 'b', quantity: CREATE_NEST_TEST_DEFAULTS.quantityPerPart },
    ])
  })

  it('applies the documented sheet / style / spacing / seed defaults', () => {
    const params = buildCreateNestParams(['a'])!
    expect(params.sheet).toEqual({ width: 300, height: 300 })
    expect(params.style).toBe('ninety')
    expect(params.spacing).toEqual({ partGap: 3, sheetMargin: 5, windowGap: 2 })
    expect(params.seed).toBe(1)
    // curveTolerance omitted -> engine default
    expect(params.curveTolerance).toBeUndefined()
  })

  it('de-duplicates repeated ids so a part is never sourced twice', () => {
    const params = buildCreateNestParams(['a', 'a', 'b'])!
    expect(params.sources.map((s) => s.geometryId)).toEqual(['a', 'b'])
  })

  it('does not share nested object references with the defaults constant', () => {
    const params = buildCreateNestParams(['a'])!
    expect(params.sheet).not.toBe(CREATE_NEST_TEST_DEFAULTS.sheet)
    expect(params.spacing).not.toBe(CREATE_NEST_TEST_DEFAULTS.spacing)
  })
})
