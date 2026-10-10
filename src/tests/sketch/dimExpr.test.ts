// "sketch-dim equations wiring" hitlist item: unit tests for src/lib/sketch/dimExpr.ts, the pure
// resolver both sketchers' dimension-value editor delegates to.
import { describe, expect, it } from 'vitest'
import { isEquationInput, previewDimInput, resolveDimInput } from '../../lib/sketch/dimExpr'

describe('resolveDimInput: plain-number path is unchanged (no leading "=")', () => {
  it('mm units: parses like parseDimToMm always has', () => {
    expect(resolveDimInput('25.4', false, 'mm')).toEqual({ ok: true, mm: 25.4 })
  })
  it('inch units: bare number reads in the ACTIVE DISPLAY units', () => {
    expect(resolveDimInput('1', false, 'inch')).toEqual({ ok: true, mm: 25.4 })
  })
  it('angle: degrees text -> radians value', () => {
    const r = resolveDimInput('90', true, 'mm')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.mm).toBeCloseTo(Math.PI / 2, 10)
  })
  it('garbage text: typed fail (NaN), never a silent 0', () => {
    expect(resolveDimInput('banana', false, 'mm')).toEqual({ ok: false, message: 'not a number' })
  })
})

describe('resolveDimInput: equation mode ("=" prefix)', () => {
  it('detects equation input regardless of surrounding whitespace', () => {
    expect(isEquationInput('=1+2')).toBe(true)
    expect(isEquationInput('  =1+2')).toBe(true)
    expect(isEquationInput('12')).toBe(false)
  })

  it('plain arithmetic: bare numbers are mm-canonical (ignores the active display-unit toggle)', () => {
    // width/2 style equation, independent of whether the sketch is currently showing mm or inch.
    expect(resolveDimInput('=50/2', false, 'mm')).toEqual({ ok: true, mm: 25, expression: '=50/2' })
    expect(resolveDimInput('=50/2', false, 'inch')).toEqual({ ok: true, mm: 25, expression: '=50/2' })
  })

  it('explicit unit suffix converts that literal to mm', () => {
    const r = resolveDimInput('=1in+2', false, 'mm')
    expect(r).toEqual({ ok: true, mm: 27.4, expression: '=1in+2' })
  })

  it('functions: sqrt/sin/cos/etc route through the DOC-4 evaluator (degrees in/out)', () => {
    expect(resolveDimInput('=sqrt(16)', false, 'mm')).toEqual({ ok: true, mm: 4, expression: '=sqrt(16)' })
    const r = resolveDimInput('=sin(30)*10', false, 'mm')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.mm).toBeCloseTo(5, 10)
  })

  it('angle dimension: equation result is used directly in degrees, then converted to radians', () => {
    const r = resolveDimInput('=45+15', true, 'mm')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.mm).toBeCloseTo(Math.PI / 3, 10) // 60 deg
  })

  it('stores the raw "=..." source (leading "=" included, trimmed) as `expression` for redisplay', () => {
    const r = resolveDimInput('  =12*2  ', false, 'mm')
    expect(r).toEqual({ ok: true, mm: 24, expression: '=12*2' })
  })

  it('empty equation is a typed refusal, not a silent 0', () => {
    expect(resolveDimInput('=', false, 'mm')).toEqual({ ok: false, message: 'empty equation' })
    expect(resolveDimInput('=   ', false, 'mm')).toEqual({ ok: false, message: 'empty equation' })
  })

  it('syntax error: typed message, never a thrown exception reaching the caller', () => {
    const r = resolveDimInput('=1+', false, 'mm')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0)
  })

  it('unknown function: typed message naming it', () => {
    const r = resolveDimInput('=frobnicate(1)', false, 'mm')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/unknown function/i)
  })

  it('division by zero: typed message, ADR-0003 fail-loud (never NaN/Infinity committed)', () => {
    const r = resolveDimInput('=1/0', false, 'mm')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/division by zero/i)
  })

  it('named reference: typed "unknown reference" message (v1 has no named refs in EITHER sketcher -- parity note in the module header)', () => {
    const r = resolveDimInput('=width/2', false, 'mm')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/width/)
  })
})

describe('previewDimInput: live preview shown while typing an equation', () => {
  it('null for plain-number text (no preview UI for the pre-existing path)', () => {
    expect(previewDimInput('25', false, 'mm')).toBeNull()
    expect(previewDimInput('', false, 'mm')).toBeNull()
  })

  it('success preview: resolved value in the field\'s own display convention', () => {
    expect(previewDimInput('=50/2', false, 'mm')).toEqual({ text: '= 25 mm', isError: false })
    // linear inch display: mm result converted to inch for the readout
    expect(previewDimInput('=25.4', false, 'inch')).toEqual({ text: '= 1 in', isError: false })
    // angle: degrees readout
    expect(previewDimInput('=45+15', true, 'mm')).toEqual({ text: '= 60 deg', isError: false })
  })

  it('error preview: same fail-loud message resolveDimInput would refuse to commit', () => {
    const preview = previewDimInput('=1+', false, 'mm')
    expect(preview?.isError).toBe(true)
    expect(preview?.text.length).toBeGreaterThan(0)
  })
})
