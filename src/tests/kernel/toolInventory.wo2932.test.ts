import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Tool } from '../../types'
import { createToolCatalog, createToolInventory, createToolModel, physicalToolKey } from '../../kernel/tools'
import type { ToolDefinition } from '../../kernel/tools'
import { TOOL_TYPE_META } from '../../lib/tool/toolMeta'
import { buildToolProfile } from '../../lib/tool/toolProfile'

const library = JSON.parse(readFileSync('docs/machine/profiles/tool_library.json', 'utf8')) as Tool[]
const model = createToolModel({ types: TOOL_TYPE_META, buildToolProfile })
const classify = (tool: ToolDefinition) => model.classify(tool).standardType
const base = library[0]
const catalogFor = (entries: ToolDefinition[]) => createToolCatalog({
  catalogId: 'caller-fixture', catalogVersion: '1.0.0', licence: 'test fixture only', entries,
})

describe('WO-2932 pure inventory', () => {
  it('defaults every actual user-library record to owned without changing the record', () => {
    const before = structuredClone(library)
    const inventory = createToolInventory(library, [], classify)
    const owned = inventory.tools({ scope: 'owned' })
    expect(owned).toHaveLength(library.length)
    expect(owned.map(entry => entry.tool.id).sort()).toEqual(library.map(tool => tool.id).sort())
    expect(owned.every(entry => entry.source === 'owned' && entry.tool.owned === undefined)).toBe(true)
    expect(library).toEqual(before)
  })

  it('keeps owned, catalog and both scopes separate, including a catalog carrying an owned flag', () => {
    const catalog = catalogFor([{ ...base, id: 'catalog-6', owned: true }])
    const inventory = createToolInventory([base, { ...base, id: 'not-owned', owned: false }], [catalog], classify)
    expect(inventory.tools({ scope: 'owned' }).map(entry => entry.tool.id)).toEqual([base.id])
    expect(inventory.tools({ scope: 'catalog' }).map(entry => [entry.tool.id, entry.source, entry.catalogVersion]))
      .toEqual([['catalog-6', 'catalog', '1.0.0']])
    expect(inventory.tools({ scope: 'both' })).toHaveLength(2)
  })

  it('takes independent deeply immutable catalog and inventory snapshots', () => {
    const input = structuredClone(base)
    const catalog = catalogFor([input])
    const inventory = createToolInventory([input], [catalog], classify)
    const result = inventory.tools({ scope: 'catalog' })
    input.feedsAndSpeeds.default.rpm = 1
    input.diameter = 999
    expect(result[0].tool.diameter).toBe(base.diameter)
    expect(result[0].tool.feedsAndSpeeds.default.rpm).toBe(base.feedsAndSpeeds.default.rpm)
    expect(() => Reflect.set(catalog.entries[0].feedsAndSpeeds.default, 'rpm', 2)).not.toThrow()
    expect(Reflect.set(result[0].tool.feedsAndSpeeds.default, 'rpm', 2)).toBe(false)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(catalog.entries)).toBe(true)
    expect(catalog.contract).toBe('kernel.toolCatalog')
    expect(catalog.schemaVersion).toBe(1)
  })

  it('preserves separate ids, libraries and tool numbers for a duplicate physical cutter', () => {
    const twin = { ...base, id: 'second-id', libraryId: 'another-library', toolNumber: 89, name: 'same cutter' }
    const entries = createToolInventory([base, twin], [catalogFor([{ ...base, id: 'catalog-id' }])], classify)
      .tools({ scope: 'both' })
    expect(new Set(entries.map(entry => entry.physicalKey)).size).toBe(1)
    expect(entries).toHaveLength(3)
    expect(entries.find(entry => entry.tool.id === 'second-id')?.tool).toEqual(twin)
  })

  it('filters exact canonical types and inclusive mm diameters without selection', () => {
    const tools = [base, { ...base, id: 'lower', diameter: 3 }, { ...base, id: 'upper', diameter: 8 },
      { ...base, id: 'ball', type: 'ball_end_mill', diameter: 4 }, { ...base, id: 'custom', type: 'custom' }]
    const inventory = createToolInventory(tools, [], classify)
    expect(inventory.tools({ scope: 'both', types: ['flat_end_mill'], diameterRange: [3, 6] })
      .map(entry => entry.tool.id).sort()).toEqual([base.id, 'lower'].sort())
    expect(inventory.tools({ scope: 'owned', types: ['other'] }).map(entry => entry.tool.id)).toEqual(['custom'])
    expect(inventory.tools({ scope: 'owned', types: [] })).toEqual([])
    expect(inventory.tools({ scope: 'owned', diameterRange: [6, 6] })).toHaveLength(2)
  })

  it.each([[8, 3], [-1, 3], [NaN, 3], [0, Infinity]])('rejects malformed diameter range %j', (a, b) => {
    expect(() => createToolInventory([base], [], classify).tools({ scope: 'owned', diameterRange: [a, b] }))
      .toThrow(RangeError)
  })

  it('orders deterministically across reversed libraries, catalogs and repeated ids', () => {
    const a = { ...base, name: 'same', feedsAndSpeeds: { ...base.feedsAndSpeeds, extra: base.feedsAndSpeeds.default } }
    const tools = [base, a, { ...base, id: 'z', libraryId: 'second' }]
    const cats = [catalogFor([base]), { ...catalogFor([a]), catalogId: 'second' }]
    const first = createToolInventory(tools, cats, classify).tools({ scope: 'both' })
    const reversed = createToolInventory([...tools].reverse(), [...cats].reverse(), classify).tools({ scope: 'both' })
    expect(reversed).toEqual(first)
  })

  it('retains unknown and retired provenance verbatim without broadening any setting', () => {
    const candidate = { ...base, lifecycle: 'retired' as const, evidence: {
      state: 'candidate', materialId: '6061-T6', machine: undefined,
      coolant: 'mist', stockCondition: 'unknown', family: 'alloy', series: '6000',
      stickout: undefined, settings: { rpm: 12000 }, outcome: 'unknown',
    } }
    const confirmed = { ...base, id: 'confirmed', evidence: { state: 'locally-confirmed', machine: 'machine-a' } }
    const published = { ...base, id: 'published', evidence: { state: 'published-tested' } }
    const entries = createToolInventory([candidate, confirmed, published], [], classify).tools({ scope: 'owned' })
    expect(entries.find(entry => entry.tool.id === candidate.id)?.tool).toEqual(candidate)
    expect(entries.find(entry => entry.tool.id === confirmed.id)?.tool).toEqual(confirmed)
    expect(entries.find(entry => entry.tool.id === published.id)?.tool).toEqual(published)
    expect(entries.every(entry => entry.tool.limits === undefined)).toBe(true)
    // Inventory is not a default selector: retirement stays visible, never promoted to active.
    expect(entries.find(entry => entry.tool.id === candidate.id)?.tool.lifecycle).toBe('retired')
  })
})

describe('WO-2932 physical comparison key', () => {
  it('normalizes exact inch and metric geometry without normalizing the source record', () => {
    const inches = { ...base, diameter: 0.375, fluteLength: 1, shankDiameter: 0.25, overallLength: 2 }
    const metric = { ...inches, diameter: 9.525, fluteLength: 25.4, shankDiameter: 6.35, overallLength: 50.8 }
    expect(physicalToolKey(inches, 'inches')).toBe(physicalToolKey(metric))
    expect(inches.diameter).toBe(0.375)
  })
  it('handles decimal exponents and zero while retaining distinct near-equal dimensions', () => {
    expect(physicalToolKey({ ...base, diameter: 1e-7 }, 'inches'))
      .toBe(physicalToolKey({ ...base, diameter: 0.00000254, fluteLength: 508, shankDiameter: 152.4, overallLength: 1524 }))
    expect(physicalToolKey({ ...base, cornerRadius: -0 })).toBe(physicalToolKey({ ...base, cornerRadius: 0 }))
    for (const diameter of [6.00001, 6.000000000000001, 6.0005]) {
      expect(physicalToolKey({ ...base, diameter })).not.toBe(physicalToolKey(base))
    }
  })
  it('distinguishes missing geometry, hand, material, neck and unknown declarations', () => {
    for (const change of [{ cornerRadius: 0 }, { cutHand: 'left' as const }, { material: 'hss' as const },
      { neckDiameter: 2 }, { declaredTypeRaw: 'custom grind' }]) {
      expect(physicalToolKey({ ...base, ...change })).not.toBe(physicalToolKey(base))
    }
    expect(physicalToolKey({ ...base, cutHand: undefined })).toBe(physicalToolKey({ ...base, cutHand: 'right' }))
    expect(physicalToolKey({ ...base, angleFromAxisDeg: undefined }))
      .not.toBe(physicalToolKey({ ...base, angleFromAxisDeg: 59 }))
  })
  it('does not convert cutting angles, feed settings, limits or installed holder into physical identity', () => {
    expect(physicalToolKey({ ...base, holderId: 'different', lengthBelowHolder: 42,
      feedsAndSpeeds: {}, limits: { maxRpm: 1 }, lifecycle: 'retired' })).toBe(physicalToolKey(base))
  })
  it('does not give nonfinite dimensions a colliding JSON null key', () => {
    expect(() => physicalToolKey({ ...base, diameter: NaN })).toThrow(RangeError)
  })
})
