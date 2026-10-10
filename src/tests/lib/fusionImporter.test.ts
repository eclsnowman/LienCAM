// Unit tests for the Fusion 360 tool-library importer's ANGLE conversion into
// the canonical Tool.angleFromAxisDeg (half-angle from the tool axis) and the
// new tool-type mappings (chamfer_mill / tapered_endmill / countersink /
// center_drill). Fixtures are hand-authored Fusion-shaped objects mirroring the
// real geometry keys (SIG = full included point angle; TA = per-side from-axis
// angle for chamfer/tapered). importFusionTools accepts a raw array OR a
// { data: [...] } wrapper; here we pass a raw array.

import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { importFusionTools, decodeToolLibraryFile } from '../../lib/fusionImporter'

function mk(type: string, geometry: Record<string, number>): unknown {
  return {
    description: `${type} test`,
    type,
    unit: 'millimeters',
    geometry: { DC: 6, ...geometry },
  }
}

describe('fusionImporter angle conversion', () => {
  it('drill: SIG 118 included -> type drill, half-angle 59', () => {
    const [t] = importFusionTools([mk('drill', { SIG: 118, TA: 118 })]).tools
    expect(t.type).toBe('drill')
    expect(t.angleFromAxisDeg).toBe(59)
  })

  it('spot drill: SIG 90 -> spot_drill, 45', () => {
    const [t] = importFusionTools([mk('spot drill', { SIG: 90 })]).tools
    expect(t.type).toBe('spot_drill')
    expect(t.angleFromAxisDeg).toBe(45)
  })

  it('center drill: SIG 118 -> center_drill, 59', () => {
    const [t] = importFusionTools([mk('center drill', { SIG: 118 })]).tools
    expect(t.type).toBe('center_drill')
    expect(t.angleFromAxisDeg).toBe(59)
  })

  it('countersink: type "counter sink" SIG 60 -> countersink, 30', () => {
    const [t] = importFusionTools([mk('counter sink', { SIG: 60 })]).tools
    expect(t.type).toBe('countersink')
    expect(t.angleFromAxisDeg).toBe(30)
  })

  it('chamfer mill: TA 22.5 from-axis -> chamfer_mill, 22.5 (NOT halved)', () => {
    const [t] = importFusionTools([mk('chamfer mill', { TA: 22.5 })]).tools
    expect(t.type).toBe('chamfer_mill')
    expect(t.angleFromAxisDeg).toBe(22.5)
  })

  it("chamfer mill (Operator's 45 deg): TA 45 -> chamfer_mill, 45", () => {
    const [t] = importFusionTools([mk('chamfer mill', { TA: 45 })]).tools
    expect(t.type).toBe('chamfer_mill')
    expect(t.angleFromAxisDeg).toBe(45)
  })

  it('tapered mill: TA 5 from-axis -> tapered_endmill, 5', () => {
    const [t] = importFusionTools([mk('tapered mill', { TA: 5 })]).tools
    expect(t.type).toBe('tapered_endmill')
    expect(t.angleFromAxisDeg).toBe(5)
  })

  it('flat end mill: SIG 0 / TA 0 -> no angle (undefined)', () => {
    const [t] = importFusionTools([mk('flat end mill', { SIG: 0, TA: 0 })]).tools
    expect(t.type).toBe('flat_end_mill')
    expect(t.angleFromAxisDeg).toBeUndefined()
  })
})

describe('fusionImporter cut hand', () => {
  it("tap left hand: type 'tap' and cutHand 'left' preserved", () => {
    const [t] = importFusionTools([mk('tap left hand', {})]).tools
    expect(t.type).toBe('tap')
    expect(t.cutHand).toBe('left')
  })

  it("tap right hand: type 'tap' and cutHand 'right'", () => {
    const [t] = importFusionTools([mk('tap right hand', {})]).tools
    expect(t.type).toBe('tap')
    expect(t.cutHand).toBe('right')
  })

  it('a tool with no declared hand keeps the right-hand default', () => {
    const [t] = importFusionTools([mk('flat end mill', { SIG: 0 })]).tools
    expect(t.cutHand).toBe('right')
  })
})

describe('decodeToolLibraryFile (Fusion .tools ZIP + plain JSON)', () => {
  const wrapper = { data: [mk('chamfer mill', { TA: 22.5 })] }

  it('unwraps a Fusion .tools ZIP (PK-magic) and returns tools.json contents', () => {
    // A .tools file is a ZIP archive with a single tools.json entry.
    const zipped = zipSync({ 'tools.json': strToU8(JSON.stringify(wrapper)) })
    const parsed = decodeToolLibraryFile(zipped) as typeof wrapper
    expect(Array.isArray(parsed.data)).toBe(true)
    // And the unwrapped payload imports correctly end-to-end.
    const [t] = importFusionTools(parsed).tools
    expect(t.type).toBe('chamfer_mill')
    expect(t.angleFromAxisDeg).toBe(22.5)
  })

  it('finds tools.json even when the ZIP nests/renames it', () => {
    const zipped = zipSync({ 'LibName/tools.json': strToU8(JSON.stringify(wrapper)) })
    const parsed = decodeToolLibraryFile(zipped) as typeof wrapper
    expect(parsed.data).toHaveLength(1)
  })

  it('parses a plain .json export (no ZIP wrapper)', () => {
    const bytes = strToU8(JSON.stringify(wrapper))
    const parsed = decodeToolLibraryFile(bytes) as typeof wrapper
    expect(parsed.data).toHaveLength(1)
  })

  it('throws (never silent) when a ZIP has no JSON entry', () => {
    const zipped = zipSync({ 'readme.txt': strToU8('not json') })
    expect(() => decodeToolLibraryFile(zipped)).toThrow(/tools\.json/i)
  })

  it('throws on malformed JSON', () => {
    expect(() => decodeToolLibraryFile(strToU8('{ not json'))).toThrow()
  })
})

describe('fusionImporter holder import', () => {
  // A Fusion tool carrying an embedded holder block (kebab-case keys).
  function mkWithHolder(guid: string): unknown {
    return {
      description: 'flat end mill with holder',
      type: 'flat end mill',
      unit: 'millimeters',
      geometry: { DC: 6 },
      holder: {
        type: 'holder',
        vendor: 'Acme',
        'product-id': 'BT30-ER16',
        description: 'BT30 ER16 holder',
        guid,
        gaugeLength: 66.7,
        segments: [
          { height: 2,  'lower-diameter': 29, 'upper-diameter': 34 },
          { height: 20, 'lower-diameter': 34, 'upper-diameter': 40 },
          { height: 30, 'lower-diameter': 40, 'upper-diameter': 50 },
        ],
      },
    }
  }

  it('extracts a holder with 3 segments, maps kebab->camel, links the tool', () => {
    const { tools, holders } = importFusionTools([mkWithHolder('guid-A')])
    expect(holders).toHaveLength(1)
    const h = holders[0]
    expect(h.id).toBe('guid-A')
    expect(h.name).toBe('BT30 ER16 holder')   // description preferred for name
    expect(h.vendor).toBe('Acme')
    expect(h.productId).toBe('BT30-ER16')
    expect(h.gaugeLength).toBe(66.7)
    expect(h.segments).toHaveLength(3)
    expect(h.segments[0]).toEqual({ height: 2, lowerDiameter: 29, upperDiameter: 34 })
    expect(h.segments[2]).toEqual({ height: 30, lowerDiameter: 40, upperDiameter: 50 })
    // The tool is linked to the holder.
    expect(tools).toHaveLength(1)
    expect(tools[0].holderId).toBe('guid-A')
  })

  it('dedupes two tools sharing the same holder guid into ONE holder', () => {
    const { tools, holders } = importFusionTools([
      mkWithHolder('guid-shared'),
      mkWithHolder('guid-shared'),
    ])
    expect(holders).toHaveLength(1)
    expect(holders[0].id).toBe('guid-shared')
    expect(tools).toHaveLength(2)
    expect(tools[0].holderId).toBe('guid-shared')
    expect(tools[1].holderId).toBe('guid-shared')
  })

  it('a tool with no holder yields no holders and no holderId link', () => {
    const { tools, holders } = importFusionTools([mk('flat end mill', { SIG: 0 })])
    expect(holders).toHaveLength(0)
    expect(tools[0].holderId).toBeUndefined()
  })
})
