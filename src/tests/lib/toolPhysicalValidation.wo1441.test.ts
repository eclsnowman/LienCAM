// WO-1441: one shared normalize-and-validate step for a Tool/ToolHolder,
// used by every write path. This file proves the primitives themselves
// (src/lib/tool/toolValidation.ts) and the Fusion importer paths wired to
// them (BUG-509 unit double-conversion, BUG-510 unknown-type preservation,
// BUG-511 negative geometry, BUG-519 holder-section validation).
// The component-level batch-diagnostics + manual-edit-rejection acceptance
// items live in src/tests/components/toolLibraryImportDiagnostics.wo1441.test.ts.

import { describe, it, expect } from 'vitest'
import { importFusionTools } from '../../lib/fusionImporter'
import {
  toCanonicalMm,
  resolveToolType,
  validateToolGeometry,
  validateHolderSegment,
  validateToolRecordShape,
} from '../../lib/tool/toolValidation'

function mk(type: string, geometry: Record<string, number>, unit = 'millimeters'): unknown {
  return { description: `${type} test`, type, unit, geometry }
}

describe('toolValidation primitives', () => {
  it('toCanonicalMm converts inches, passes mm through unchanged', () => {
    expect(toCanonicalMm(1, 'inches')).toBeCloseTo(25.4)
    expect(toCanonicalMm(6.35, 'millimeters')).toBe(6.35)
  })

  it('resolveToolType maps a known key case-insensitively, flags an unknown one', () => {
    const map = { 'flat end mill': 'flat_end_mill' as const }
    expect(resolveToolType('Flat End Mill', map, 'flat_end_mill')).toEqual({ type: 'flat_end_mill' })
    expect(resolveToolType('giant laser drill', map, 'flat_end_mill')).toEqual({
      type: 'flat_end_mill',
      unknownDeclaredType: 'giant laser drill',
    })
    expect(resolveToolType(undefined, map, 'flat_end_mill')).toEqual({
      type: 'flat_end_mill',
      unknownDeclaredType: undefined,
    })
  })

  it('validateToolGeometry rejects a nonpositive/nonfinite dimension', () => {
    const base = { diameter: 6, shankDiameter: 6, fluteLength: 18, overallLength: 50 }
    expect(validateToolGeometry(base)).toEqual({ ok: true })
    expect(validateToolGeometry({ ...base, diameter: -2 }).ok).toBe(false)
    expect(validateToolGeometry({ ...base, diameter: 0 }).ok).toBe(false)
    expect(validateToolGeometry({ ...base, diameter: NaN }).ok).toBe(false)
    expect(validateToolGeometry({ ...base, overallLength: -1 }).ok).toBe(false)
  })

  it('validateToolGeometry rejects lengthBelowHolder exceeding overallLength (BUG-536)', () => {
    const base = { diameter: 6, shankDiameter: 6, fluteLength: 18, overallLength: 50 }
    expect(validateToolGeometry({ ...base, lengthBelowHolder: 30 })).toEqual({ ok: true })
    const rejected = validateToolGeometry({ ...base, lengthBelowHolder: 3030 })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.reason).toMatch(/lengthBelowHolder/)
  })

  it('validateHolderSegment rejects a nonpositive/nonfinite section dimension', () => {
    expect(validateHolderSegment({ height: 10, lowerDiameter: 20, upperDiameter: 20 })).toEqual({ ok: true })
    expect(validateHolderSegment({ height: 0, lowerDiameter: 20, upperDiameter: 20 }).ok).toBe(false)
    expect(validateHolderSegment({ height: 10, lowerDiameter: -5, upperDiameter: 20 }).ok).toBe(false)
    expect(validateHolderSegment({ height: NaN, lowerDiameter: 20, upperDiameter: 20 }).ok).toBe(false)
  })

  it('validateToolRecordShape recovers a nameless record and numeric-text geometry (WO-1542), still rejects null/non-numeric (BUG-518)', () => {
    const valid = validateToolRecordShape({ name: 'T1', diameter: 6 })
    expect(valid.ok).toBe(true)
    if (!valid.ok) return
    expect(valid.record.nameGenerated).toBe(false)
    expect(valid.record.tool).toMatchObject({ name: 'T1', diameter: 6 })
    expect(validateToolRecordShape(null).ok).toBe(false)
    // WO-1542 (rule 11): both of these are recoverable, not shape defects.
    const nameless = validateToolRecordShape({ name: '', diameter: 6 })
    expect(nameless.ok).toBe(true)
    if (!nameless.ok) return
    expect(nameless.record.nameGenerated).toBe(true)
    expect(typeof nameless.record.tool.name).toBe('string')
    const textDiameter = validateToolRecordShape({ name: 'T1', diameter: '6' })
    expect(textDiameter.ok).toBe(true)
    if (!textDiameter.ok) return
    expect(textDiameter.record.tool.diameter).toBe(6)
    // Unrecoverable values are still refused.
    expect(validateToolRecordShape({ name: 'T1', diameter: 'abc' }).ok).toBe(false)
    expect(validateToolRecordShape({ name: 'T1', diameter: null }).ok).toBe(false)
  })
})

describe('fusionImporter: BUG-509 single unit conversion', () => {
  it('an inch tool with only DC=0.25 resolves identically to an equivalent metric DC=6.35 tool', () => {
    const inch = importFusionTools([mk('flat end mill', { DC: 0.25 }, 'inches')]).tools[0]
    const metric = importFusionTools([mk('flat end mill', { DC: 6.35 }, 'millimeters')]).tools[0]
    expect(inch.diameter).toBeCloseTo(6.35, 6)
    expect(inch.shankDiameter).toBeCloseTo(metric.shankDiameter, 6)
    expect(inch.fluteLength).toBeCloseTo(metric.fluteLength, 6)
    expect(inch.overallLength).toBeCloseTo(metric.overallLength, 6)
    // The pre-fix bug specifically produced grossly inflated values (~4x)
    // when a fallback derived from an already-converted mm value was
    // converted a second time — pin the correct magnitude directly too.
    expect(inch.shankDiameter).toBeLessThan(10)
    expect(inch.overallLength).toBeLessThan(50)
  })
})

describe('fusionImporter: BUG-510 unknown cutter type is preserved, not silently promoted', () => {
  it('imports an unrecognized type under a fallback, preserving the declared string and reporting it once', () => {
    const { tools, diagnostics } = importFusionTools([mk('giant laser drill', { DC: 6 })])
    expect(tools).toHaveLength(1)
    expect(tools[0].type).toBe('flat_end_mill')
    expect(tools[0].declaredTypeRaw).toBe('giant laser drill')
    expect(diagnostics.some((d) => d.reason.includes('giant laser drill'))).toBe(true)
  })

  it('a recognized type carries no declaredTypeRaw and no diagnostic', () => {
    const { tools, diagnostics } = importFusionTools([mk('flat end mill', { DC: 6 })])
    expect(tools[0].declaredTypeRaw).toBeUndefined()
    expect(diagnostics).toHaveLength(0)
  })
})

describe('fusionImporter: BUG-511 negative/impossible geometry is rejected, not registered', () => {
  it('a record with DC=-2 mm is rejected; the reason names the field', () => {
    const { tools, diagnostics } = importFusionTools([mk('flat end mill', { DC: -2 })])
    expect(tools).toHaveLength(0)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].reason).toMatch(/diameter/)
  })

  it('one bad record does not blank a batch of otherwise-valid records', () => {
    const { tools, diagnostics } = importFusionTools([
      mk('flat end mill', { DC: 6 }),
      mk('flat end mill', { DC: -2 }),
      mk('ball end mill', { DC: 8 }),
    ])
    expect(tools).toHaveLength(2)
    expect(diagnostics).toHaveLength(1)
  })
})

describe('fusionImporter: BUG-519 holder section validation', () => {
  function mkWithHolderSections(segments: Array<Record<string, unknown>>): unknown {
    return {
      description: 'flat end mill with holder',
      type: 'flat end mill',
      unit: 'millimeters',
      geometry: { DC: 6 },
      holder: {
        type: 'holder',
        guid: 'guid-holder-1',
        name: 'Test holder',
        segments,
      },
    }
  }

  it('rejects a zero-height section, a negative-dimension section, and a string/null/missing-dimension section; valid sections still import', () => {
    const { tools, holders, diagnostics } = importFusionTools([
      mkWithHolderSections([
        { height: 10, 'lower-diameter': 20, 'upper-diameter': 20 },       // valid
        { height: 0, 'lower-diameter': 20, 'upper-diameter': 20 },        // zero height
        { height: 10, 'lower-diameter': -5, 'upper-diameter': 20 },       // negative diameter
        { height: '10', 'lower-diameter': null, 'upper-diameter': undefined }, // string/null/missing
      ]),
    ])
    expect(tools[0].holderId).toBe('guid-holder-1')
    expect(holders).toHaveLength(1)
    expect(holders[0].segments).toHaveLength(1)
    expect(holders[0].segments[0]).toEqual({ height: 10, lowerDiameter: 20, upperDiameter: 20 })
    // 3 rejected sections, each with its own reason.
    const holderRejects = diagnostics.filter((d) => d.label.includes('holder'))
    expect(holderRejects).toHaveLength(3)
  })

  it('a holder with every section invalid yields no holder at all (not a degenerate one)', () => {
    const { tools, holders, diagnostics } = importFusionTools([
      mkWithHolderSections([
        { height: 0, 'lower-diameter': 0, 'upper-diameter': 0 },
        { height: -1, 'lower-diameter': 10, 'upper-diameter': 10 },
      ]),
    ])
    expect(holders).toHaveLength(0)
    expect(tools[0].holderId).toBeUndefined()
    expect(diagnostics.filter((d) => d.label.includes('holder'))).toHaveLength(2)
  })
})
