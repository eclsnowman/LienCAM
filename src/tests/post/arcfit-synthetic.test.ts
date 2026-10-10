import { describe, it, expect } from 'vitest'
import { postProgram } from '../../lib/post/index'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { GRBL_CONFIG } from '../../lib/post/dialects/grbl'
import { lintGcode } from '../../lib/gcode/lint'
import { buildSyntheticInput } from './fixtures/syntheticSetup'

// Arc-collapse INTEGRATION test (C-P2): posts the synthetic fixture with the
// REAL arcs-ON dialect configs. The fixture now carries a densely-sampled
// circular feature (the arc-collapse target) plus DENSIFIED straight edges, so
// the collapser has honest work to do: the circle -> a few G2/G3 arcs, the
// straight runs -> plain G1 lines. We also exercise the linter's ARC_NO_CENTER
// rule against real emitted arcs (every arc must carry I/J).

// Count emitted arc moves. The motion word (G2/G3) is MODAL, so a run of
// consecutive arcs only prints G2/G3 once; subsequent arcs reuse it. Every arc,
// modal or not, carries center offsets (I and/or J), and ONLY arcs do — so an
// I/J-bearing line is a reliable per-arc-move counter.
function arcBlockCount(gcode: string): number {
  return gcode
    .split('\n')
    .filter((line) => /\bI-?[\d.]/.test(line) || /\bJ-?[\d.]/.test(line)).length
}

describe('synthetic arc-collapse job — UCCNC (arcs ON)', () => {
  const result = postProgram(buildSyntheticInput(), UCCNC_CONFIG)

  it('posts ok with zero error diagnostics', () => {
    expect(result.ok).toBe(true)
    expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([])
  })

  it('emits G2/G3 arcs (the dense circle collapsed to arcs)', () => {
    expect(/\bG2\b/.test(result.gcode) || /\bG3\b/.test(result.gcode)).toBe(true)
  })

  it('collapses the circle to a SMALL number of arc blocks (real collapse)', () => {
    const arcs = arcBlockCount(result.gcode)
    // A full circle splits at 180deg -> minimum 2 arcs; allow a little slack for
    // breakpoint placement, but FAR fewer than one-arc-per-chord (64 samples).
    expect(arcs).toBeGreaterThanOrEqual(2)
    expect(arcs).toBeLessThanOrEqual(8)
  })

  it('still emits plain G1 line moves for the straight densified edges', () => {
    expect(/\bG1\b/.test(result.gcode)).toBe(true)
  })

  it('passes the linter with zero errors (exercises ARC_NO_CENTER on real arcs)', () => {
    const errors = lintGcode(result.gcode, { commentStyle: 'paren' }).filter(
      (f) => f.level === 'error',
    )
    expect(errors).toEqual([])
  })

  it('is deterministic across two runs (byte-identical)', () => {
    const a = postProgram(buildSyntheticInput(), UCCNC_CONFIG).gcode
    const b = postProgram(buildSyntheticInput(), UCCNC_CONFIG).gcode
    expect(a).toBe(b)
  })
})

describe('synthetic arc-collapse job — GRBL (arcs ON)', () => {
  const result = postProgram(buildSyntheticInput(), GRBL_CONFIG)

  it('posts ok and emits arcs', () => {
    expect(result.ok).toBe(true)
    expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([])
    expect(/\bG2\b/.test(result.gcode) || /\bG3\b/.test(result.gcode)).toBe(true)
  })

  it('collapses the circle to a small number of arc blocks', () => {
    const arcs = arcBlockCount(result.gcode)
    expect(arcs).toBeGreaterThanOrEqual(2)
    expect(arcs).toBeLessThanOrEqual(8)
  })

  it('still emits plain G1 line moves for the straight densified edges', () => {
    expect(/\bG1\b/.test(result.gcode)).toBe(true)
  })

  it('passes the linter with zero errors', () => {
    const errors = lintGcode(result.gcode, { commentStyle: 'paren' }).filter(
      (f) => f.level === 'error',
    )
    expect(errors).toEqual([])
  })

  it('is deterministic across two runs (byte-identical)', () => {
    const a = postProgram(buildSyntheticInput(), GRBL_CONFIG).gcode
    const b = postProgram(buildSyntheticInput(), GRBL_CONFIG).gcode
    expect(a).toBe(b)
  })
})
