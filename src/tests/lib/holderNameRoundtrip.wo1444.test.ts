// WO-1444: a holder RENAME must survive export/import.
//
// `ToolHolder` carries separate `name` and `description` fields. The editor's
// "Name" field writes `.name`, but the wrapped-format holder block only ever
// carried `description` (export) and derived `name` from it (import) — so a
// rename was invisible in the exported JSON. These tests pin the additive
// `name` field on both sides of the roundtrip.

import { describe, it, expect } from 'vitest'
import { importFusionTools, serializeHolderForFusion } from '../../lib/fusionImporter'
import type { ToolHolder } from '../../types'

function mkHolder(overrides: Partial<ToolHolder> = {}): ToolHolder {
  return {
    id: 'guid-1',
    name: 'REVIEW renamed holder',
    vendor: 'Acme',
    productId: 'BT30-ER16',
    description: 'BT30 ER16 holder',
    gaugeLength: 66.7,
    segments: [
      { height: 2, lowerDiameter: 29, upperDiameter: 34 },
      { height: 20, lowerDiameter: 34, upperDiameter: 40 },
    ],
    ...overrides,
  }
}

function wrap(holder: Record<string, unknown>): unknown {
  return {
    description: 'flat end mill with holder',
    type: 'flat end mill',
    unit: 'millimeters',
    geometry: { DC: 6 },
    holder,
  }
}

describe('WO-1444 holder name survives export/import', () => {
  it('acceptance 1: serialize emits the renamed .name even when description differs', () => {
    const block = serializeHolderForFusion(mkHolder())
    expect(block.name).toBe('REVIEW renamed holder')
    expect(block.description).toBe('BT30 ER16 holder')
  })

  it('acceptance 2: parse prefers an explicit name over the description fallback', () => {
    const { holders } = importFusionTools([
      wrap({
        type: 'holder',
        guid: 'guid-A',
        name: 'REVIEW renamed holder',
        description: 'BT30 ER16 holder',
        vendor: 'Acme',
        'product-id': 'BT30-ER16',
        segments: [{ height: 2, 'lower-diameter': 29, 'upper-diameter': 34 }],
      }),
    ])
    expect(holders).toHaveLength(1)
    expect(holders[0].name).toBe('REVIEW renamed holder')
  })

  it('acceptance 3: parse with NO name keeps the description fallback (today behaviour)', () => {
    const { holders } = importFusionTools([
      wrap({
        type: 'holder',
        guid: 'guid-A',
        description: 'BT30 ER16 holder',
        vendor: 'Acme',
        'product-id': 'BT30-ER16',
        segments: [{ height: 2, 'lower-diameter': 29, 'upper-diameter': 34 }],
      }),
    ])
    expect(holders).toHaveLength(1)
    expect(holders[0].name).toBe('BT30 ER16 holder')
  })

  it('acceptance 4: rename -> export -> reimport keeps the renamed name', () => {
    const renamed = mkHolder({ name: 'REVIEW renamed holder' })
    const block = serializeHolderForFusion(renamed)
    const { holders } = importFusionTools([wrap(block as Record<string, unknown>)])
    expect(holders).toHaveLength(1)
    expect(holders[0].name).toBe('REVIEW renamed holder')
  })
})
