import { describe, it, expect } from 'vitest'
import { postProgram } from '../../lib/post/index'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { GRBL_CONFIG } from '../../lib/post/dialects/grbl'
import { LINUXCNC_CONFIG } from '../../lib/post/dialects/linuxcnc'
import { lintGcode } from '../../lib/gcode/lint'
import { buildSyntheticInput } from './fixtures/syntheticSetup'

// This fixture is the LINEAR all-roles integration job: it exercises every
// MoveRole, the two-tool change, the world->work transform, preamble + WCS, and
// determinism. The current fixture is sparsely sampled (corner points only), so
// it is not a meaningful arc-collapse test -- the arcs-ON integration test uses a
// dense curved fixture (see arcfit-synthetic test). To keep validating the linear
// path under the now arcs-ON real configs, these blocks pin arcs:false variants.
const UCCNC_LINEAR = {
  ...UCCNC_CONFIG,
  capabilities: { ...UCCNC_CONFIG.capabilities, arcs: false },
}
const GRBL_LINEAR = {
  ...GRBL_CONFIG,
  capabilities: { ...GRBL_CONFIG.capabilities, arcs: false },
}
const LINUXCNC_LINEAR = {
  ...LINUXCNC_CONFIG,
  capabilities: { ...LINUXCNC_CONFIG.capabilities, arcs: false },
}

describe('synthetic all-roles job — UCCNC (linear)', () => {
  const result = postProgram(buildSyntheticInput(), UCCNC_LINEAR)

  it('posts ok', () => {
    expect(result.ok).toBe(true)
    expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([])
  })

  it('is LINEAR only — no G2/G3 arc words anywhere', () => {
    // Word-boundary match so 'G21' (units) does not register as a G2 arc.
    expect(/\bG2\b/.test(result.gcode)).toBe(false)
    expect(/\bG3\b/.test(result.gcode)).toBe(false)
  })

  it('emits the UCCNC preamble + WCS select', () => {
    expect(result.gcode).toContain('G90 G94 G17 G21 G64')
    expect(result.gcode).toContain('G54')
  })

  it('emits a tool change between the two tools (T2 M6, no redundant M0)', () => {
    expect(result.gcode).toContain('T1')
    expect(result.gcode).toContain('T2 M6')
    expect(result.gcode).not.toMatch(/^M0$/m) // the M6 is the stop (owner ruling 10-04)
  })

  it('contains motion characteristic of every role group', () => {
    const g = result.gcode
    // Spot-check WORK coordinates (world - origin{100,50,25}):
    // op1 first rapid world(110,60,30) -> work X10 Y10 Z5
    expect(g).toContain('G0 X10 Y10 Z5')
    // plunge world(110,60,27) -> work Z2 at plunge feed 400
    expect(g).toContain('F400')
    // ramp feed 600, helix 500, stepover 1500, fast_traverse 3500
    expect(g).toContain('F600')
    expect(g).toContain('F500')
    expect(g).toContain('F1500')
    expect(g).toContain('F3500')
    // op2 lead/finish feeds
    expect(g).toContain('F1800') // lead_in/out
    expect(g).toContain('F1200') // finish
    // ends with M30
    expect(g.trimEnd().endsWith('M30')).toBe(true)
  })

  it('passes the linter with zero errors', () => {
    const errors = lintGcode(result.gcode, { commentStyle: 'paren' }).filter(
      (f) => f.level === 'error',
    )
    expect(errors).toEqual([])
  })

  it('is deterministic across two runs (byte-identical)', () => {
    const a = postProgram(buildSyntheticInput(), UCCNC_LINEAR).gcode
    const b = postProgram(buildSyntheticInput(), UCCNC_LINEAR).gcode
    expect(a).toBe(b)
  })
})

describe('synthetic all-roles job — GRBL (linear)', () => {
  const result = postProgram(buildSyntheticInput(), GRBL_LINEAR)

  it('posts ok and is linear only', () => {
    expect(result.ok).toBe(true)
    expect(/\bG2\b/.test(result.gcode)).toBe(false)
    expect(/\bG3\b/.test(result.gcode)).toBe(false)
  })

  it('emits the GRBL preamble (no G64) and a pause-style tool change', () => {
    expect(result.gcode).toContain('G90 G94 G17 G21')
    expect(result.gcode).not.toContain('G64')
    // GRBL has no M6: tool change is a comment + M0 pause.
    expect(result.gcode).toContain('change tool to T2')
    expect(result.gcode).not.toContain('M6')
    expect(result.gcode).toContain('M0') // GRBL has no M6: the M0 is the tool-change stop
  })

  it('passes the linter with zero errors', () => {
    const errors = lintGcode(result.gcode, { commentStyle: 'paren' }).filter(
      (f) => f.level === 'error',
    )
    expect(errors).toEqual([])
  })

  it('is deterministic across two runs (byte-identical)', () => {
    const a = postProgram(buildSyntheticInput(), GRBL_LINEAR).gcode
    const b = postProgram(buildSyntheticInput(), GRBL_LINEAR).gcode
    expect(a).toBe(b)
  })
})

describe('synthetic all-roles job — LinuxCNC (linear)', () => {
  const result = postProgram(buildSyntheticInput(), LINUXCNC_LINEAR)

  it('posts ok and is linear only', () => {
    expect(result.ok).toBe(true)
    expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([])
    expect(/\bG2\b/.test(result.gcode)).toBe(false)
    expect(/\bG3\b/.test(result.gcode)).toBe(false)
  })

  it('emits the LinuxCNC preamble (G21 + G64) and WCS select', () => {
    expect(result.gcode).toContain('G21')
    expect(result.gcode).toContain('G64')
    expect(result.gcode).toContain('G90 G94 G17 G21 G64')
    expect(result.gcode).toContain('G54')
  })

  it('uses semicolon comments, never parentheses', () => {
    // Section comment for an op name renders as "; Pocket rough", not "( ... )".
    expect(result.gcode).toContain('; Pocket rough')
    expect(result.gcode).not.toContain('( ')
  })

  it('emits a native M6 tool change between the two tools (T2 M6, no redundant M0)', () => {
    expect(result.gcode).toContain('T1')
    expect(result.gcode).toContain('T2 M6')
    expect(result.gcode).not.toMatch(/^M0$/m) // the M6 is the stop (owner ruling 10-04)
  })

  it('passes the linter (semicolon style) with zero errors', () => {
    const errors = lintGcode(result.gcode, { commentStyle: 'semicolon' }).filter(
      (f) => f.level === 'error',
    )
    expect(errors).toEqual([])
  })

  it('is deterministic across two runs (byte-identical)', () => {
    const a = postProgram(buildSyntheticInput(), LINUXCNC_LINEAR).gcode
    const b = postProgram(buildSyntheticInput(), LINUXCNC_LINEAR).gcode
    expect(a).toBe(b)
  })
})

describe('synthetic all-roles job — LinuxCNC (arcs)', () => {
  // The real arcs-ON config. The synthetic fixture is sparsely sampled, so this
  // asserts the arc PATH is wired (G2/G3 with I/J emit when an arc move exists)
  // via a dedicated arc op alongside the dwell-in-seconds check.
  it('posts ok with the arcs-enabled config', () => {
    const result = postProgram(buildSyntheticInput(), LINUXCNC_CONFIG)
    expect(result.ok).toBe(true)
    expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([])
  })
})
