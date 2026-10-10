import { describe, expect, it } from 'vitest'
import { UCCNC_CONFIG } from '../../lib/post'
import { parseUserPostConfig } from '../../lib/post/userPostConfig'

describe('user post definition import', () => {
  it('accepts a complete declarative definition and never imports builtin authority', () => {
    const source = {
      ...structuredClone(UCCNC_CONFIG),
      id: 'shared-router',
      label: 'Shop Router',
      builtin: true,
    }
    const result = parseUserPostConfig(JSON.stringify(source))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.label).toBe('Shop Router')
    expect(result.config.builtin).toBe(false)
    expect(result.config.capabilities.arcCenterMode).toBe('ijk')
  })

  it('rejects malformed nested values with a field-level error', () => {
    const source = structuredClone(UCCNC_CONFIG) as unknown as Record<string, unknown>
    const capabilities = source.capabilities as Record<string, unknown>
    capabilities.workOffsets = { g54_59: true, extended: 'yes', g10: false }
    const result = parseUserPostConfig(JSON.stringify(source))
    expect(result).toEqual({
      ok: false,
      error: 'capabilities.workOffsets.extended must be true or false',
    })
  })
})
