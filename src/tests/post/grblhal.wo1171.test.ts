import { describe, expect, it } from 'vitest'
import { BUILT_IN_DIALECTS, GRBL_CONFIG, GRBLHAL_CONFIG, postProgram } from '../../lib/post'
import { downloadFilenameForConfig, extForConfig } from '../../lib/post/downloadExtension'
import { buildSyntheticInput } from './fixtures/syntheticSetup'

describe('WO-1171 grblHAL post identity', () => {
  it('is a named built-in and downloads with the required .nc extension', () => {
    expect(BUILT_IN_DIALECTS.find((config) => config.id === 'grblhal')).toBe(GRBLHAL_CONFIG)
    expect(GRBLHAL_CONFIG.label).toBe('grblHAL')
    expect(extForConfig(GRBLHAL_CONFIG)).toBe('nc')
    expect(downloadFilenameForConfig('HAL Part', GRBLHAL_CONFIG)).toBe('HAL_Part.nc')
  })

  it('emits GRBL-identical program bytes after removing only its identity header', () => {
    const grbl = postProgram(buildSyntheticInput(), GRBL_CONFIG)
    const grblhal = postProgram(buildSyntheticInput(), GRBLHAL_CONFIG)

    expect(grbl.ok).toBe(true)
    expect(grblhal.ok).toBe(true)
    expect(grblhal.gcode.split('\n')[0]).toBe('( grblHAL )')
    expect(grblhal.gcode.split('\n').slice(1).join('\n')).toBe(grbl.gcode)
  })
})
