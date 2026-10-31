// @vitest-environment jsdom
//
// WO-3307 (UI M2 W2-2b): the 3D operations in the parameter schema. Parallel, Waterline, Adaptive
// rough, Scallop, Steep and shallow and Pencil each declare every field the old dialog and
// Properties panel show, once, with the old editors' units and (wider) limits, their linked edits,
// tool seeds and stored forms; the one operation card (the WO-3283 renderer) draws them; every
// word is in this order's locale files in en, de, es and fr. The parity with the old editors'
// stored results is operationParity3d.wo3307.test.ts.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  applyEdit, defaultsFor, opSchema, readValues, validateFor,
  type OpContext, type ParamValues, type StoredOperation,
} from '../../lib/opschema'
import { SCHEMAS_3D, schema3dFor, storedParamsOf } from '../../lib/opschema/schemas/3d'
import { OpSchemaForm } from '../../components/opschema'
import { resolveMessage, type MessageKey } from '../../notices'
import { ENGLISH_CATALOG } from '../../i18n/catalogs'
import { parameterDefaults } from '../../kernel/parameterDefaults'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import { buildParallel3dSmartIntent } from '../../lib/cam/smartHeights'

const ROOT = join(__dirname, '..', '..', '..')
const AREA = 'ui2-operation-card-3d.wo3307'
afterEach(cleanup)

const schemaOf = (opType: string) => {
  const schema = schema3dFor(opType)
  expect(schema, `no schema for ${opType}`).toBeDefined()
  return schema!
}

// Every field the old dialog and Properties panel show for each 3D type, as [key, quantity, min,
// max] (undefined = none). The wider of the two editors' limits (LIENCAM.md rule 11).
type Row = readonly [key: string, quantity: string | undefined, min: number | undefined, max: number | undefined]
const PICKS: readonly Row[] = [['toolId', undefined, undefined, undefined], ['geometrySelections', undefined, undefined, undefined]]
const FACES: Row = ['params.faceScope', undefined, undefined, undefined]
const FIELDS: Record<string, readonly Row[]> = {
  parallel_3d: [...PICKS, FACES,
    ['params.useStockBoundary', undefined, undefined, undefined],
    ['params.stockEdgeOvershoot', 'length', 0, undefined],
    ['params.stepover', 'length', 0.05, undefined],
    ['params.angleDeg', 'angle', 0, 180],
    ['params.surfaceStockToLeave', 'length', 0, undefined],
    ['params.finishDepth', 'length', 0.01, undefined],
    ['params.tolerance', 'length', 0.001, undefined]],
  waterline_3d: [...PICKS, FACES,
    ['params.useStockBoundary', undefined, undefined, undefined],
    ['params.stepdown', 'length', 0.05, undefined],
    ['params.stockToLeave', 'length', 0, undefined],
    ['params.minSlopeDeg', 'angle', 0, 89],
    ['params.finishDepth', 'length', 0.01, undefined],
    ['params.order', undefined, undefined, undefined],
    ['params.direction', undefined, undefined, undefined],
    ['params.flatAreaDetection', undefined, undefined, undefined],
    ['params.tolerance', 'length', 0.001, undefined]],
  adaptive_3d: [...PICKS,
    ['params.useStockBoundary', undefined, undefined, undefined],
    ['params.stockEdgeOvershoot', 'length', 0, undefined],
    ['params.maxStepdown', 'length', 0.1, undefined],
    ['params.stepover', 'none', 0.05, 1],
    ['params.millingDirection', undefined, undefined, undefined],
    ['params.intermediateStepdown', undefined, undefined, undefined],
    ['params.radialStockToLeave', 'length', 0, undefined],
    ['params.axialStockToLeave', 'length', 0, undefined],
    ['params.helixDiameter', 'length', 0.5, undefined],
    ['params.helixAngleDeg', 'angle', 0.5, 30],
    ['params.wallLeadInRadius', 'length', 0, undefined],
    ['params.wallLeadOutRadius', 'length', 0, undefined],
    ['params.loopbackFilletPct', 'percent', 5, 100],
    ['params.integralWallFollow', undefined, undefined, undefined],
    ['params.integralWallFollowLengthFactor', 'none', 0.1, 10],
    ['params.tolerance', 'length', 0.001, undefined],
    ['params.cellSize', 'length', 0.1, undefined]],
  scallop_3d: [...PICKS, FACES,
    ['params.useStockBoundary', undefined, undefined, undefined],
    ['params.scallopHeight', 'length', 0.001, undefined],
    ['params.stockToLeave', 'length', 0, undefined],
    ['params.finishDepth', 'length', 0.01, undefined],
    ['params.direction', undefined, undefined, undefined],
    ['params.tolerance', 'length', 0.001, undefined]],
  steep_shallow_3d: [...PICKS, FACES,
    ['params.useStockBoundary', undefined, undefined, undefined],
    ['params.thresholdDeg', 'angle', 0, 90],
    ['params.stepdown', 'length', 0.05, undefined],
    ['params.stepover', 'length', 0.05, undefined],
    ['params.angleDeg', 'angle', 0, undefined],
    ['params.stockToLeave', 'length', 0, undefined],
    ['params.finishDepth', 'length', 0.01, undefined],
    ['params.tolerance', 'length', 0.001, undefined]],
  pencil_3d: [...PICKS, FACES,
    ['params.useStockBoundary', undefined, undefined, undefined],
    ['params.stockToLeave', 'length', 0, undefined],
    ['params.finishDepth', 'length', 0.01, undefined],
    ['params.direction', undefined, undefined, undefined],
    ['params.tolerance', 'length', 0.001, undefined]],
}
const TYPES_3D = Object.keys(FIELDS)

describe('WO-3307 the 3D operation schemas', () => {
  it('declares a schema for every 3D operation type the store has', () => {
    const storeTypes = Object.keys(parameterDefaults).filter(t => t.endsWith('_3d')).sort()
    expect(storeTypes).toEqual([...TYPES_3D].sort())
    expect(SCHEMAS_3D.map(s => s.opType).sort()).toEqual(storeTypes)
    for (const type of storeTypes) expect(schemaOf(type).opType).toBe(type)
    expect(schema3dFor('pocket_2d')).toBeUndefined()
  })

  for (const type of TYPES_3D) {
    it(`${type}: declares every field the old editors show, with their units and limits`, () => {
      const schema = schemaOf(type)
      expect(schema.params.map(p => [p.key, p.quantity, p.range?.min, p.range?.max])).toEqual(FIELDS[type])
    })
  }

  it('starts each type with the old defaults the store keeps for it', () => {
    for (const type of TYPES_3D) {
      const stored = storedParamsOf(schemaOf(type), opSchema.defaultsOf(schemaOf(type)))
      const old = parameterDefaults[type as keyof typeof parameterDefaults] as unknown as Record<string, unknown>
      // the old default records carry two fields neither old editor shows (Parallel's slope limit,
      // Waterline's and Scallop's edge overrun); every field the schema stores matches
      for (const [field, value] of Object.entries(stored)) expect(value, `${type}.${field}`).toEqual(old[field])
      expect(Object.keys(stored).length).toBeGreaterThan(3)
    }
  })

  it('seeds a new operation from its tool as the old dialog does', () => {
    const ctx = { toolDiameter: 6, libraryStepoverMm: 0.4 } as OpContext
    expect(defaultsFor(schemaOf('parallel_3d'), ctx)['params.stepover']).toBe(0.4)
    expect(defaultsFor(schemaOf('steep_shallow_3d'), ctx)['params.stepover']).toBe(0.4)
    // Adaptive: the library stepover as a fraction of the diameter, to 0.01, inside 0.01..1
    expect(defaultsFor(schemaOf('adaptive_3d'), ctx)['params.stepover']).toBe(0.07)
    expect(defaultsFor(schemaOf('adaptive_3d'), { toolDiameter: 2, libraryStepoverMm: 5 } as OpContext)['params.stepover']).toBe(1)
    // Waterline: 10% of the diameter, at least 0.2 mm
    expect(defaultsFor(schemaOf('waterline_3d'), ctx)['params.stepdown']).toBe(0.6)
    expect(defaultsFor(schemaOf('waterline_3d'), { toolDiameter: 1 })['params.stepdown']).toBe(0.2)
    // no library stepover: the flat defaults
    expect(defaultsFor(schemaOf('parallel_3d'), { toolDiameter: 6 })['params.stepover']).toBe(1)
    expect(defaultsFor(schemaOf('adaptive_3d'), { toolDiameter: 6 })['params.stepover']).toBe(0.4)
  })

  it('reads a blank optional number as blank, and an automatic grid as blank', () => {
    const p = readValues(schemaOf('parallel_3d'), { params: { stepover: 2, finishDepth: undefined } })
    expect(p['params.finishDepth']).toBeNull()
    expect(p['params.stockEdgeOvershoot']).toBeNull()
    expect(p['params.surfaceStockToLeave']).toBe(0)
    expect(p['params.stepover']).toBe(2)
    const a = readValues(schemaOf('adaptive_3d'), { params: { cellSize: 0 } })
    expect(a['params.cellSize']).toBeNull()
    expect(readValues(schemaOf('adaptive_3d'), { params: { cellSize: 0.5 } })['params.cellSize']).toBe(0.5)
  })

  it('stores a blank optional number as absent, never as null, so the toolpath reads it as unset', () => {
    const op: StoredOperation = { params: { finishDepth: 4, stockEdgeOvershoot: 1, stepover: 1 } }
    expect(applyEdit(schemaOf('parallel_3d'), op, 'params.stockEdgeOvershoot', null)).toEqual({ params: { finishDepth: 4, stockEdgeOvershoot: undefined, stepover: 1 } })
    const depth = applyEdit(schemaOf('waterline_3d'), op, 'params.finishDepth', null) as { params: Record<string, unknown> }
    expect('finishDepth' in depth.params && depth.params.finishDepth === undefined).toBe(true)
  })

  it('stores the automatic grid as 0 and a non-positive wall-ride limit as the default factor', () => {
    const op: StoredOperation = { params: { cellSize: 0.5, integralWallFollowLengthFactor: 3 } }
    const adaptive = schemaOf('adaptive_3d')
    expect(applyEdit(adaptive, op, 'params.cellSize', null)).toEqual({ params: { cellSize: 0, integralWallFollowLengthFactor: 3 } })
    expect(applyEdit(adaptive, op, 'params.integralWallFollowLengthFactor', 0)).toEqual({ params: { cellSize: 0.5, integralWallFollowLengthFactor: 2 } })
    expect(applyEdit(adaptive, op, 'params.integralWallFollowLengthFactor', 4.5)).toEqual({ params: { cellSize: 0.5, integralWallFollowLengthFactor: 4.5 } })
  })

  it('stores the picked solid as the one selection and the picked faces as sorted unique ids', () => {
    const op: StoredOperation = { geometrySelections: ['old'], params: { stepover: 1, faceScope: { faceIds: [9] } } }
    const parallel = schemaOf('parallel_3d')
    expect(applyEdit(parallel, op, 'geometrySelections', 'solid-2')).toEqual({ geometrySelections: ['solid-2'] })
    expect(applyEdit(parallel, op, 'params.faceScope', [7, 3, 7] as unknown as ParamValues[string])).toEqual({ params: { stepover: 1, faceScope: { faceIds: [3, 7] } } })
    // no faces picked = the whole part: the scope goes
    expect(applyEdit(parallel, op, 'params.faceScope', [] as unknown as ParamValues[string])).toEqual({ params: { stepover: 1, faceScope: undefined } })
  })

  it('re-authors the Smart Height authority on a finish-depth edit when the screen gives the setup', () => {
    const op: StoredOperation = {
      geometrySelections: ['solid-1'], heights: { heightIntent: defaultHeightIntent() }, params: { stepover: 1 },
    }
    const setup = { id: 'setup-1', defaultHeightIntent: defaultHeightIntent() }
    const patch = applyEdit(schemaOf('parallel_3d'), op, 'params.finishDepth', 3, { setup } as Parameters<typeof applyEdit>[4])
    expect(patch).toEqual({
      params: { stepover: 1, finishDepth: 3 },
      smartHeight: { kind: 'smart_v2', intent: buildParallel3dSmartIntent({ setupId: 'setup-1', geometryIds: ['solid-1'], safetyIntent: defaultHeightIntent(), finishDepthMm: 3 }) },
    })
    // without the setup only the depth is stored (contract request: EditContext.setup)
    expect(applyEdit(schemaOf('parallel_3d'), op, 'params.finishDepth', 3)).toEqual({ params: { stepover: 1, finishDepth: 3 } })
  })

  it('reports a value outside the old limits by name', () => {
    const values = { ...opSchema.defaultsOf(schemaOf('waterline_3d')), 'params.minSlopeDeg': 95, 'params.stepdown': 0.01 }
    const issues = validateFor(schemaOf('waterline_3d'), values).map(i => i.key).sort()
    expect(issues).toEqual(['params.minSlopeDeg', 'params.stepdown'])
  })

  it('never reports an untouched seeded stepover, even below the typed minimum (rule 11)', () => {
    // a 0.2 mm library stepover on a 6 mm tool: Adaptive seeds 0.03 of the diameter, Parallel and
    // Steep and shallow 0.02 mm; the old dialog stores and computes these as they are
    const low = { toolDiameter: 6, libraryStepoverMm: 0.2 } as OpContext
    const lower = { toolDiameter: 6, libraryStepoverMm: 0.02 } as OpContext
    expect(defaultsFor(schemaOf('adaptive_3d'), low)['params.stepover']).toBe(0.03)
    expect(validateFor(schemaOf('adaptive_3d'), defaultsFor(schemaOf('adaptive_3d'), low), low)).toEqual([])
    for (const type of ['parallel_3d', 'steep_shallow_3d']) {
      expect(defaultsFor(schemaOf(type), lower)['params.stepover']).toBe(0.02)
      expect(validateFor(schemaOf(type), defaultsFor(schemaOf(type), lower), lower)).toEqual([])
    }
    // without such a seed the old editors' minimum holds
    const typed = { ...defaultsFor(schemaOf('adaptive_3d'), { toolDiameter: 6 }), 'params.stepover': 0.03 }
    expect(validateFor(schemaOf('adaptive_3d'), typed, { toolDiameter: 6 }).map(i => i.key)).toEqual(['params.stepover'])
    expect(validateFor(schemaOf('adaptive_3d'), { ...typed, 'params.stepover': 0.04 }, low).map(i => i.key)).toEqual([])
  })

  it('is frozen, so no screen changes a shared declaration', () => {
    for (const schema of SCHEMAS_3D) expect(Object.isFrozen(schema.params)).toBe(true)
  })

  it('imports no React, store or screen code', () => {
    const dir = join(ROOT, 'src/lib/opschema/schemas/3d')
    const files = readdirSync(dir).filter(f => /\.ts$/.test(f))
    expect(files.length).toBeGreaterThanOrEqual(7)
    for (const f of files) {
      const specs = [...readFileSync(join(dir, f), 'utf8').matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(m => m[1])
      expect(specs.filter(s => /^react|\/store\b|\/components\/|\/ui2\//.test(s)), f).toEqual([])
    }
  })
})

describe('WO-3307 the operation card draws the 3D schemas', () => {
  /** Draws a card and opens the sections that start folded (spec 6.4). */
  const draw = (opType: string, values?: ParamValues, onChange = vi.fn()) => {
    const schema = schemaOf(opType)
    const view = render(<OpSchemaForm schema={schema} values={values ?? opSchema.defaultsOf(schema)} onChange={onChange} />)
    for (const header of view.container.querySelectorAll('[data-kit="Section"] > button[aria-expanded="false"]')) fireEvent.click(header)
    return view
  }
  const captions = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-kit="Section"] > button > span:first-child')].map(e => e.textContent)

  it('Waterline: sections in spec order, its fields, and slots for the tool, solid and faces', () => {
    const { container } = draw('waterline_3d')
    expect(captions(container)).toEqual(['Tool', 'Geometry', 'Passes', 'Options'])
    for (const name of ['Stepdown', 'Wall stock', 'Steep only above', 'Finish depth limit', 'Tolerance']) {
      expect(screen.getByRole('textbox', { name })).toBeTruthy()
    }
    expect(screen.getByRole('radiogroup', { name: 'Order' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Direction' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Flat area detection' })).toBeTruthy()
    expect([...container.querySelectorAll('[data-opschema-slot]')].map(e => e.getAttribute('data-opschema-slot')))
      .toEqual(['toolId', 'geometrySelections', 'params.faceScope'])
  })

  it('Parallel: sections in spec order and its fields; the blank finish depth is an optional field', () => {
    const { container } = draw('parallel_3d')
    expect(captions(container)).toEqual(['Tool', 'Geometry', 'Advanced', 'Passes', 'Options'])
    for (const name of ['Stepover', 'Pass angle', 'Surface stock', 'Finish depth limit', 'Edge overrun', 'Tolerance']) {
      expect(screen.getByRole('textbox', { name })).toBeTruthy()
    }
    expect((screen.getByRole('textbox', { name: 'Finish depth limit' }) as HTMLInputElement).value).toBe('')
  })

  it('Adaptive: the edge overrun shows only when clearing all stock, the wall-ride limit only with wall follow', () => {
    const schema = schemaOf('adaptive_3d')
    draw('adaptive_3d')
    expect(screen.queryByRole('textbox', { name: 'Edge overrun' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Max wall ride' })).toBeTruthy()
    cleanup()
    draw('adaptive_3d', { ...opSchema.defaultsOf(schema), 'params.useStockBoundary': true, 'params.integralWallFollow': false })
    expect(screen.getByRole('textbox', { name: 'Edge overrun' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Max wall ride' })).toBeNull()
  })

  it('reports each edit with the parameter key and the value the schema stores', () => {
    const onChange = vi.fn()
    draw('scallop_3d', undefined, onChange)
    const height = screen.getByRole('textbox', { name: 'Scallop height' })
    fireEvent.change(height, { target: { value: '0.01' } })
    fireEvent.blur(height)
    fireEvent.click(screen.getByRole('radio', { name: 'Conventional' }))
    expect(onChange.mock.calls).toEqual([['params.scallopHeight', 0.01], ['params.direction', 'conventional']])
  })

  it('draws every 3D type without an issue at its defaults', () => {
    for (const type of TYPES_3D) {
      draw(type)
      expect(screen.queryAllByRole('alert'), type).toEqual([])
      cleanup()
    }
  })
})

describe('WO-3307 words', () => {
  const keysOf = (tree: unknown, prefix = ''): string[] =>
    Object.entries(tree as Record<string, unknown>).flatMap(([k, v]) => typeof v === 'string' ? [prefix + k] : keysOf(v, `${prefix}${k}.`))
  const used = () => SCHEMAS_3D.flatMap(s => s.params.flatMap(p => [p.labelKey, p.helpKey, ...(p.choices ?? []).map(c => c.labelKey)]))
    .filter((k): k is MessageKey => k !== undefined)

  it('has an English text for every word the 3D schemas use, in this order\'s own file', () => {
    const english = ENGLISH_CATALOG[AREA as keyof typeof ENGLISH_CATALOG]
    expect(english).toBeDefined()
    const keys = new Set(keysOf(english))
    const words = used()
    expect(words.length).toBeGreaterThan(60)
    expect(words.filter(k => !k.startsWith(`${AREA}:`) || !keys.has(k.slice(AREA.length + 1)))).toEqual([])
    for (const k of words) expect(resolveMessage(k)).not.toContain(AREA)
    for (const type of TYPES_3D) expect(keys.has(`type.${type}`), type).toBe(true)
  })

  it('has the same keys in German, Spanish and French, each a real text', async () => {
    const en = keysOf((await import('../../i18n/locales/en/ui2-operation-card-3d.wo3307')).default).sort()
    expect(en.length).toBeGreaterThan(60)
    for (const lang of ['de', 'es', 'fr']) {
      const other = (await import(`../../i18n/locales/${lang}/ui2-operation-card-3d.wo3307.ts`)).default
      expect(keysOf(other).sort(), lang).toEqual(en)
    }
  })

  it('keeps every field label inside the card\'s label budget in all four languages', async () => {
    // a coarse bound no field label or choice may pass (a toggle's label runs the card's width);
    // the real fit is measured per label in a browser in all four languages (evidence
    // label-check.json: no label or choice wider or taller than its box, no choice row past the card)
    const BUDGET = 32
    for (const lang of ['en', 'de', 'es', 'fr']) {
      const words = (await import(`../../i18n/locales/${lang}/ui2-operation-card-3d.wo3307.ts`)).default as { field: Record<string, string>; choice: Record<string, Record<string, string>> }
      expect(Object.keys(words.field ?? {}).length, `${lang} field labels`).toBeGreaterThan(30)
      const long = [...Object.values(words.field), ...Object.values(words.choice ?? {}).flatMap(c => Object.values(c))].filter(t => t.length > BUDGET)
      expect(long, lang).toEqual([])
    }
  })
})
