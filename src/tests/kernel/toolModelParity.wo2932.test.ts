import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Tool, ToolHolder } from '../../types'
import { createToolInventory, createToolModel, physicalToolKey } from '../../kernel/tools'
import { TOOL_TYPE_META, TOOL_TYPE_ORDER } from '../../lib/tool/toolMeta'
import { buildToolProfile, buildHolderProfile, tipOffsetAtRadius } from '../../lib/tool/toolProfile'
import type { ToolProfile } from '../../lib/tool/toolProfile'
import { toolToCutterSpec, UnsupportedCutterError } from '../../cam3d/integration/cutterSpec'
import { resolveToolType } from '../../lib/tool/toolValidation'
import { normalizeToolCutHand } from '../../lib/tool/cutHand'
import { toolLibraryToCsv } from '../../lib/tools/toolLibraryCsv'
import { TOOLS } from '../benchmark/registry'
import { alpha3Tools } from '../benchmark/alpha3Registry'

const library = JSON.parse(readFileSync('docs/machine/profiles/tool_library.json', 'utf8')) as Tool[]
const examples = readdirSync('examples').filter(folder => /^\d\d-/.test(folder)).flatMap(folder =>
  readdirSync(join('examples', folder)).filter(file => file.endsWith('.camproject')).flatMap(file =>
    JSON.parse(readFileSync(join('examples', folder, file), 'utf8')).toolLibrary as Tool[]))
// The machine/example corpus has no bull-nose. Take cutting dimensions from the
// actual benchmark registry; remaining non-cutting fields use an explicit library donor.
const benchmarkControls = TOOLS.map(spec => ({ ...library[0], id: spec.id, type: spec.type,
  diameter: spec.diameter, fluteLength: spec.fluteLengthMm, cornerRadius: spec.cornerRadius }))
const model = createToolModel({ types: TOOL_TYPE_META, buildToolProfile })
const base = library[0]

describe('WO-2932 real tool model parity', () => {
  it('uses the complete canonical type table without an alternate numbering scheme', () => {
    expect(TOOL_TYPE_ORDER).toHaveLength(19)
    for (const type of TOOL_TYPE_ORDER) {
      const view = model.describe({ ...base, type })
      expect(view.standardType).toBe(type)
      expect(view.metadata).toEqual(TOOL_TYPE_META[type])
      expect(view.typeStatus).toBe('known')
      expect(view.profile).toEqual(buildToolProfile({ ...base, type }))
    }
  })

  it('totally maps actual machine library, example, benchmark and alpha3 tools', () => {
    const actual = [...library, ...examples, ...TOOLS, ...alpha3Tools()]
    expect(actual.length).toBeGreaterThan(TOOLS.length + library.length)
    for (const tool of actual) {
      const classification = model.classify(tool)
      expect(classification.standardType, tool.id).toBe(tool.type)
      expect(classification.metadata, tool.id).toEqual(TOOL_TYPE_META[tool.type])
    }
  })

  it('carries every actual field and production profile exactly through the boundary', () => {
    const actual = [...library, ...examples, ...alpha3Tools().flatMap(tool => tool.libraryTool ? [tool.libraryTool] : [])]
    for (const tool of actual) {
      const before = structuredClone(tool)
      const view = model.describe(tool)
      expect(view.record, tool.id).toEqual(before)
      expect(view.profile, tool.id).toEqual(buildToolProfile(tool))
      expect(view.geometry.lengthBelowHolder).toBe(tool.lengthBelowHolder)
      expect(view.geometry.neckDiameter).toBe(tool.neckDiameter)
      expect(view.geometry.shoulderLength).toBe(tool.shoulderLength)
      expect(view.cutHand).toBe(normalizeToolCutHand(tool.cutHand))
      expect(view.record.feedsAndSpeeds).toEqual(tool.feedsAndSpeeds)
      expect(tool).toEqual(before)
    }
  })

  it('keeps legacy importer fallback and raw unknown declaration; raw custom types stay other', () => {
    const resolved = resolveToolType('Custom Form Cutter', { endmill: 'flat_end_mill' as const }, 'flat_end_mill')
    const imported = { ...base, type: resolved.type, declaredTypeRaw: resolved.unknownDeclaredType }
    expect(model.describe(imported)).toMatchObject({ standardType: 'flat_end_mill', typeStatus: 'fallback' })
    expect(model.describe(imported).record.declaredTypeRaw).toBe('Custom Form Cutter')
    expect(model.describe(imported).profile).toEqual(buildToolProfile(imported))
    for (const type of ['legacy_custom', '', '__proto__', 'toString']) {
      const view = model.describe({ ...base, type })
      expect(view.standardType).toBe('other')
      expect(view.typeStatus).toBe('unknown')
      expect(view.profile).toBeUndefined()
      expect(view.record.type).toBe(type)
    }
  })

  it('retains optional limits and centre-cutting facts without guessing from feeds', () => {
    const view = model.describe(base)
    expect(view.record).not.toHaveProperty('limits')
    expect(view.limits).toBeUndefined()
    expect(view.centreCutting).toBeUndefined()
    expect(view.geometry.lengthBelowHolder).toBeUndefined()
    expect(model.describe({ ...base, limits: { maxRpm: 9000, maxApFracD: 0.3 }, centreCutting: false }))
      .toMatchObject({ limits: { maxRpm: 9000, maxApFracD: 0.3 }, centreCutting: false })
    expect(model.describe({ ...base, cutHand: undefined }).cutHand).toBe('right')
    expect(model.describe({ ...base, cutHand: 'left' }).cutHand).toBe('left')
  })

  it('resolves exact existing holder records and keeps missing holder/stickout not checked', () => {
    const holder: ToolHolder = { id: 'fixture-holder', name: 'caller holder', gaugeLength: 50,
      segments: [{ height: 10, lowerDiameter: 12, upperDiameter: 20 }] }
    expect(model.describe(base).holder.status).toBe('not-checked')
    expect(model.describe({ ...base, holderId: 'missing' }, [holder]).holder)
      .toMatchObject({ reference: 'missing', status: 'not-checked', clearanceStatus: 'not-checked' })
    const noStickout = model.describe({ ...base, holderId: holder.id }, [holder]).holder
    expect(noStickout).toMatchObject({ status: 'resolved', clearanceStatus: 'not-checked', record: holder })
    const view = model.describe({ ...base, holderId: holder.id, lengthBelowHolder: 30 }, [holder])
    expect(view.holder.clearanceStatus).toBe('data-present')
    expect(buildHolderProfile(structuredClone(view.holder.record) as ToolHolder)).toEqual(buildHolderProfile(holder))
    expect(Object.isFrozen(view.holder.record?.segments[0])).toBe(true)
    expect(Reflect.set(view.holder.record!.segments[0], 'height', 999)).toBe(false)
    expect(holder.segments[0].height).toBe(10)
  })

  it('retains current cutter specs and unsupported-type refusals for actual library/example records', () => {
    const seen = new Set<string>()
    for (const tool of [...library, ...examples, ...benchmarkControls]) {
      const augmented = { ...tool, centreCutting: true, limits: { maxRpm: 1 } }
      const adapted = structuredClone(model.describe(augmented).record) as Tool
      try {
        const expected = toolToCutterSpec(tool)
        expect(toolToCutterSpec(adapted)).toEqual(expected)
        seen.add(expected.kind)
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedCutterError)
        expect(() => toolToCutterSpec(adapted)).toThrow((error as Error).message)
      }
    }
    expect([...seen].sort()).toEqual(['ball', 'bull', 'flat', 'vbit'])
  })

  it('checks profile bottom surfaces against independent analytic current-cutter controls', () => {
    const actual = [...library, ...examples, ...benchmarkControls]
    for (const type of ['flat_end_mill', 'ball_end_mill', 'bull_nose', 'v_bit'] as const) {
      const tool = actual.find(tool => tool.type === type && (type !== 'bull_nose' || (tool.cornerRadius ?? 0) > 0))!
      expect(tool, type).toBeDefined()
      const cutter = toolToCutterSpec(tool)
      const profile = structuredClone(model.describe(tool).profile) as ToolProfile
      const radius = cutter.diameter / 2
      for (const fraction of [0, 0.25, 0.5, 0.75, 0.95]) {
        const r = radius * fraction
        let expected = 0
        if (cutter.kind === 'ball') expected = radius - Math.sqrt(radius ** 2 - r ** 2)
        if (cutter.kind === 'bull') {
          const x = Math.max(0, r - (radius - cutter.cornerRadius))
          expected = cutter.cornerRadius - Math.sqrt(cutter.cornerRadius ** 2 - x ** 2)
        }
        if (cutter.kind === 'vbit') expected = Math.max(0, r - (cutter.tipDiameter ?? 0) / 2)
          / Math.tan(cutter.angleFromAxisDeg * Math.PI / 180)
        // Existing revolved arcs are polylines (40 ball / 24 bull segments), not analytic circles.
        expect(Math.abs(tipOffsetAtRadius(profile, r) - expected), `${tool.id} r=${r}`).toBeLessThan(0.02)
      }
    }
  })

  it('supports a real headless caller without migrating production tool choices or feed recipes', () => {
    const explicit = base.id
    const original = toolLibraryToCsv(library, [])
    const inventory = createToolInventory(library, [], tool => model.classify(tool).standardType)
    const adapted = inventory.tools({ scope: 'owned' }).map(entry => structuredClone(model.describe(entry.tool).record) as Tool)
    const inOriginalOrder = library.map(tool => adapted.find(adaptedTool => adaptedTool.id === tool.id)!)
    expect(toolLibraryToCsv(inOriginalOrder, [])).toBe(original)
    expect(inOriginalOrder.find(tool => tool.id === explicit)?.feedsAndSpeeds).toEqual(base.feedsAndSpeeds)
    expect(physicalToolKey(inOriginalOrder.find(tool => tool.id === explicit)!)).toBe(physicalToolKey(base))
  })
})
