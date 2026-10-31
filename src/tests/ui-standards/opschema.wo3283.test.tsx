// @vitest-environment jsdom
//
// WO-3283 (UI M2 W1-F): the operation-parameter schema. One declaration per operation type
// draws both the New Operation card and the Properties panel: the service gives defaults,
// visibility, group order, list items and the range checks; the renderer draws any schema with
// the kit inputs and reports edits; the Pocket pilot declares every field the old Pocket editors
// show, with their defaults, units and limits, and an edit through the schema stores what the
// old editors store for the same edit.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  applyEdit, choicesOf, defaultsFor, issueMessage, opSchema, readValues, validateFor,
  type OpSchema, type ParamDecl, type ParamIssue, type ParamValues, type StoredOperation,
} from '../../lib/opschema'
import { POCKET_SCHEMA, schemaFor } from '../../lib/opschema/schemas'
import { OpSchemaForm } from '../../components/opschema'
import { resolveMessage } from '../../notices'
import { ENGLISH_CATALOG } from '../../i18n/catalogs'
import { defaultHeights, defaultLinking, defaultPasses, defaultPocketParams } from '../../kernel/parameterDefaults'
import { deriveHeightPlaneOffsetUpdate } from '../../lib/cam/heightReference'
import { normalizePocketEntryForFillStrategy } from '../../lib/cam/pocketEntryPolicy'
import { CORNER_RELIEF_STYLES, gentleEngagementLimits } from '../../lib/cam/cornerRelief2d'
import { DEFAULT_CLEARANCE_ALLOWANCE_MM } from '../../lib/cam/holderClearanceGate'
import { DEFAULT_FLOOR_HOP_MM } from '../../lib/cam/moves'

const ROOT = join(__dirname, '..', '..', '..')
const AREA = 'ui2-opschema.wo3283'
afterEach(cleanup)

// A small schema exercising every parameter type, independent of any operation.
const LABEL = `${AREA}:pocket.stepdown` as const
const sample: OpSchema = {
  opType: 'sample',
  params: [
    { key: 'depth', type: 'number', quantity: 'length', range: { min: 0.5, max: 30 }, default: 2, labelKey: LABEL, group: 'passes' },
    { key: 'dia', type: 'number', quantity: 'length', range: { min: 0, minExclusive: true }, default: 6, labelKey: LABEL, group: 'tool' },
    { key: 'count', type: 'integer', quantity: 'count', range: { min: 1 }, default: 1, labelKey: LABEL, group: 'passes' },
    { key: 'hidden', type: 'number', quantity: 'length', range: { max: 1 }, default: 0, labelKey: LABEL, group: 'passes', visible: v => v.count === 99 },
    { key: 'cap', type: 'number', quantity: 'length', range: { min: 0 }, default: null, labelKey: LABEL, group: 'passes' },
    {
      key: 'steps', type: 'list', default: [{ d: 6, l: 20 }], labelKey: LABEL, group: 'tool',
      item: [
        { key: 'd', type: 'number', quantity: 'length', range: { min: 0, minExclusive: true }, default: 6, labelKey: LABEL, group: 'tool' },
        { key: 'l', type: 'number', quantity: 'length', range: { min: 0 }, default: 10, labelKey: LABEL, group: 'tool' },
      ],
    },
  ],
}

describe('WO-3283 schema service', () => {
  it('reports a value outside its range, naming the field and the limit', () => {
    const values = { ...opSchema.defaultsOf(sample), depth: 40, dia: 0, count: 0 }
    const issues = opSchema.validate(sample, values)
    expect(issues.map(i => i.key)).toEqual(['depth', 'dia', 'count'])
    const text = issues.map(i => resolveMessage(i.reason, i.params))
    expect(text[0]).toBe('Stepdown must be at most 30 mm')
    expect(text[1]).toBe('Stepdown must be more than 0 mm')
    expect(text[2]).toBe('Stepdown must be at least 1')
  })

  it('accepts every value inside its range, an empty optional value and hidden parameters', () => {
    expect(opSchema.validate(sample, { ...opSchema.defaultsOf(sample), depth: 30, dia: 0.001, hidden: 5 })).toEqual([])
  })

  it('checks the fields of every list item and names the item', () => {
    const values = { ...opSchema.defaultsOf(sample), steps: [{ d: 6, l: 20 }, { d: 0, l: -1 }] }
    const issues = opSchema.validate(sample, values)
    expect(issues.map(i => i.key)).toEqual(['steps.1.d', 'steps.1.l'])
    expect(resolveMessage(issues[1].reason, issues[1].params)).toBe('Stepdown must be at least 0 mm')
  })

  it('gives each operation its own copy of a list default', () => {
    const a = opSchema.defaultsOf(sample)
    const b = opSchema.defaultsOf(sample)
    expect(a.steps).toEqual([{ d: 6, l: 20 }])
    expect(a.steps).not.toBe(b.steps)
  })
})

// ------------------------------------------------------------------------------- Pocket pilot
// Every field the old Pocket editors show (New Operation dialog and Properties panel), with the
// quantity, step and limits they use. Where the two editors differ, the wider limit stands,
// because a value either editor accepts is one the software runs (LIENCAM.md rule 11).
const POCKET_FIELDS: Record<string, Partial<ParamDecl>> = {
  'toolId': { type: 'tool', group: 'tool' },
  'params.clearanceAllowanceMm': { type: 'number', quantity: 'length', step: 0.05, range: { min: 0 }, group: 'tool' },
  'params.boundarySource': { type: 'choice', group: 'geometry' },
  'params.geometryId': { type: 'geometry', group: 'geometry' },
  'params.direction': { type: 'choice', group: 'passes' },
  'passes.stepdown': { type: 'number', quantity: 'length', step: 0.5, range: { min: 0.01 }, group: 'passes' },
  'passes.stepover': { type: 'number', quantity: 'length', step: 0.5, range: { min: 0.01 }, group: 'passes' },
  'passes.stockToLeave': { type: 'number', quantity: 'length', step: 0.05, range: { min: 0 }, group: 'passes' },
  'passes.floorStockToLeave': { type: 'number', quantity: 'length', step: 0.05, range: { min: 0 }, group: 'passes' },
  'params.fillStrategy': { type: 'choice', group: 'passes', advanced: true },
  'params.overlapMm': { type: 'number', quantity: 'length', step: 0.5, range: { min: 0, max: 20 }, group: 'passes', advanced: true },
  'params.stepoverLeadIn': { type: 'choice', group: 'passes', advanced: true },
  'params.roundRingCorners': { type: 'boolean', group: 'passes', advanced: true },
  'params.orderStrategy': { type: 'choice', group: 'passes', advanced: true },
  'params.finishContour': { type: 'boolean', group: 'passes', advanced: true },
  'passes.finishPasses': { type: 'integer', quantity: 'count', step: 1, range: { min: 1 }, group: 'passes', advanced: true },
  'passes.springPasses': { type: 'integer', quantity: 'count', step: 1, range: { min: 0 }, group: 'passes', advanced: true },
  'params.stayDown': { type: 'boolean', group: 'passes', advanced: true },
  'params.stayDownLift': { type: 'number', quantity: 'length', step: 0.1, range: { min: 0.1, max: 10 }, group: 'passes', advanced: true },
  'params.cornerRelief': { type: 'choice', group: 'custom:corners', advanced: true },
  'params.cornerReliefGentle': { type: 'boolean', group: 'custom:corners', advanced: true },
  'params.cornerReliefEngagement': { type: 'number', quantity: 'length', step: 0.1, group: 'custom:corners', advanced: true },
  'linking.entryType': { type: 'choice', group: 'linking' },
  'params.helixDiameter': { type: 'number', quantity: 'percent', step: 5, range: { min: 10, max: 95 }, group: 'linking' },
  'linking.rampAngle': { type: 'number', quantity: 'angle', step: 0.5, range: { min: 0.5, max: 30 }, group: 'linking' },
  'params.entryClearance': { type: 'number', quantity: 'length', step: 0.5, range: { min: 0 }, group: 'linking' },
  'linking.floorHopMm': { type: 'number', quantity: 'length', step: 0.1, range: { min: 0 }, group: 'linking' },
  'params.slotFeedPercent': { type: 'number', quantity: 'percent', step: 5, range: { min: 1, max: 100 }, group: 'feeds' },
}

const CHOICES: Record<string, string[]> = {
  'params.boundarySource': ['geometry', 'stock'],
  'params.direction': ['climb', 'conventional'],
  'params.fillStrategy': ['outside_in', 'inside_out'],
  'params.stepoverLeadIn': ['none', 'arc'],
  'params.orderStrategy': ['by_region', 'by_depth'],
  'params.cornerRelief': [...CORNER_RELIEF_STYLES],
  'linking.entryType': ['plunge', 'ramp_linear', 'ramp_helical'],
}

/** A stored Pocket, as the store holds one. */
interface PocketOp extends StoredOperation {
  readonly toolId: string | null
  readonly params: Readonly<Record<string, unknown>>
  readonly passes: Readonly<Record<string, unknown>>
  readonly linking?: Readonly<Record<string, unknown>>
  readonly heights?: Readonly<Record<string, unknown>>
}

/** What the New Operation dialog stores for a Pocket the operator leaves untouched: the shipped
 *  defaults, with the entry its fill strategy allows (the dialog normalises it on open). */
const freshPocket = (): PocketOp => ({
  toolId: null,
  params: { ...defaultPocketParams },
  passes: { ...defaultPasses },
  linking: { ...defaultLinking, entryType: normalizePocketEntryForFillStrategy(defaultPocketParams.fillStrategy, defaultLinking.entryType) },
})

/** A Pocket saved before most of the optional fields existed: only the fields every Pocket has. */
const oldPocket = (): PocketOp => ({
  toolId: 't1',
  params: { geometryId: 'g1', loopIds: ['a'], direction: 'climb', orderStrategy: 'by_region', floorStockToLeave: 0, finishContour: true, helixDiameter: 90, overlapMm: 1, stepoverLeadIn: 'arc', stayDown: false, stayDownLift: 1 },
  passes: { ...defaultPasses },
})

describe('WO-3283 Pocket pilot schema', () => {
  it('is the schema for the Pocket operation type', () => {
    expect(POCKET_SCHEMA.opType).toBe('pocket_2d')
    expect(schemaFor('pocket_2d')).toBe(POCKET_SCHEMA)
    expect(schemaFor('not_an_operation')).toBeUndefined()
  })

  it('declares every field the old Pocket editors show, with their units and limits', () => {
    expect(POCKET_SCHEMA.params.map(p => p.key).sort()).toEqual(Object.keys(POCKET_FIELDS).sort())
    for (const p of POCKET_SCHEMA.params) {
      const want = POCKET_FIELDS[p.key]
      expect({ key: p.key, type: p.type, quantity: p.quantity, step: p.step, range: p.range, group: p.group, advanced: p.advanced ?? false })
        .toEqual({ key: p.key, type: want.type, quantity: want.quantity, step: want.step, range: want.range, group: want.group, advanced: want.advanced ?? false })
      if (p.type === 'choice') expect(p.choices?.map(c => c.value)).toEqual(CHOICES[p.key])
    }
  })

  it('starts a new Pocket with the same values the New Operation dialog stores', () => {
    const defaults = opSchema.defaultsOf(POCKET_SCHEMA)
    expect(readValues(POCKET_SCHEMA, freshPocket())).toEqual(defaults)
    expect(defaults['linking.entryType']).toBe('ramp_helical')
    expect(defaults['params.helixDiameter']).toBe(90)
    expect(defaults['params.slotFeedPercent']).toBe(100)
    expect(defaults['params.clearanceAllowanceMm']).toBe(DEFAULT_CLEARANCE_ALLOWANCE_MM)
    expect(defaults['linking.floorHopMm']).toBe(DEFAULT_FLOOR_HOP_MM)
    expect(defaults['params.cornerReliefEngagement']).toBeNull()
    expect(opSchema.validate(POCKET_SCHEMA, defaults)).toEqual([])
  })

  it('seeds a new Pocket from its tool as the dialog does: stepover 35% of the diameter, to 0.1 mm', () => {
    const seeded = defaultsFor(POCKET_SCHEMA, { toolDiameter: 6 })
    expect(seeded['passes.stepover']).toBe(2.1)
    expect(readValues(POCKET_SCHEMA, { ...freshPocket(), passes: { ...defaultPasses, stepover: 2.1 } })).toEqual(seeded)
    expect(defaultsFor(POCKET_SCHEMA)).toEqual(opSchema.defaultsOf(POCKET_SCHEMA))
  })

  it('holds the gentle-corner engagement to the tool limits both old editors use', () => {
    const decl = POCKET_SCHEMA.params.find(p => p.key === 'params.cornerReliefEngagement')!
    const values = { ...opSchema.defaultsOf(POCKET_SCHEMA), 'params.cornerRelief': 'dogbone', 'params.cornerReliefGentle': true, 'params.cornerReliefEngagement': 4 }
    const limits = gentleEngagementLimits(6)
    const issues = validateFor(POCKET_SCHEMA, values, { toolDiameter: 6 })
    expect(issues.map(i => issueMessage(i))).toEqual([`Max engagement must be at most ${limits.max} mm`])
    expect(validateFor(POCKET_SCHEMA, { ...values, 'params.cornerReliefEngagement': limits.min }, { toolDiameter: 6 })).toEqual([])
    expect(opSchema.validate(POCKET_SCHEMA, values)).toEqual([])
    expect(decl.range).toBeUndefined()
  })

  it('offers only the entries the fill strategy runs, as the old lists do', () => {
    const decl = POCKET_SCHEMA.params.find(p => p.key === 'linking.entryType')!
    const base = opSchema.defaultsOf(POCKET_SCHEMA)
    expect(choicesOf(POCKET_SCHEMA, decl, { ...base, 'params.fillStrategy': 'inside_out' }).map(c => c.value)).toEqual(['plunge', 'ramp_helical'])
    expect(choicesOf(POCKET_SCHEMA, decl, { ...base, 'params.fillStrategy': 'outside_in', 'linking.entryType': 'plunge' }).map(c => c.value)).toEqual(['plunge', 'ramp_linear'])
    // a stored entry the strategy no longer runs still shows, beside the reason
    expect(choicesOf(POCKET_SCHEMA, decl, { ...base, 'params.fillStrategy': 'outside_in', 'linking.entryType': 'ramp_helical' }).map(c => c.value)).toEqual(['plunge', 'ramp_linear', 'ramp_helical'])
  })

  it('is frozen, so no screen changes the shared declaration', () => {
    expect(Object.isFrozen(POCKET_SCHEMA)).toBe(true)
    expect(Object.isFrozen(POCKET_SCHEMA.params)).toBe(true)
  })

  it('reads a negative floor hop or shank clearance as the default, as the toolpath does', () => {
    const op = { ...freshPocket(), params: { ...freshPocket().params, clearanceAllowanceMm: -2 }, linking: { ...freshPocket().linking, floorHopMm: -1 } }
    expect(readValues(POCKET_SCHEMA, op)).toMatchObject({ 'linking.floorHopMm': DEFAULT_FLOOR_HOP_MM, 'params.clearanceAllowanceMm': DEFAULT_CLEARANCE_ALLOWANCE_MM })
    expect(readValues(POCKET_SCHEMA, { ...op, linking: { ...op.linking, floorHopMm: 0 } })['linking.floorHopMm']).toBe(0)
  })

  it('reads the floor stock from passes, else from the older Pocket param, as the dialog and the toolpath do', () => {
    const { floorStockToLeave: _unset, ...passesWithout } = freshPocket().passes
    const op = (passes: Record<string, unknown>, floor: number) => ({ ...freshPocket(), passes, params: { ...freshPocket().params, floorStockToLeave: floor } })
    expect(readValues(POCKET_SCHEMA, op(passesWithout, 0.8))['passes.floorStockToLeave']).toBe(0.8)
    expect(readValues(POCKET_SCHEMA, op({ ...passesWithout, floorStockToLeave: 0 }, 0.8))['passes.floorStockToLeave']).toBe(0)
    expect(readValues(POCKET_SCHEMA, op({ ...passesWithout, floorStockToLeave: 0.3 }, 0.8))['passes.floorStockToLeave']).toBe(0.3)
  })

  it('shows a field an older Pocket never stored the way the old editors show it', () => {
    const values = readValues(POCKET_SCHEMA, oldPocket())
    expect(values).toMatchObject({
      'toolId': 't1',
      'params.boundarySource': 'geometry',
      'params.fillStrategy': 'outside_in',
      'params.cornerRelief': 'none',
      'params.cornerReliefGentle': false,
      'params.roundRingCorners': false,
      'params.entryClearance': 1,
      'params.slotFeedPercent': 100,
      'params.clearanceAllowanceMm': DEFAULT_CLEARANCE_ALLOWANCE_MM,
      'linking.entryType': 'plunge',
      'linking.rampAngle': 2,
      'linking.floorHopMm': DEFAULT_FLOOR_HOP_MM,
    })
  })

  it('shows each entry field only for the entry that uses it', () => {
    const keys = (v: ParamValues) => opSchema.visibleParams(POCKET_SCHEMA, v).map(p => p.key)
    const base = opSchema.defaultsOf(POCKET_SCHEMA)
    const helix = keys({ ...base, 'linking.entryType': 'ramp_helical' })
    expect(helix).toEqual(expect.arrayContaining(['params.helixDiameter', 'linking.rampAngle', 'params.entryClearance']))
    const ramp = keys({ ...base, 'params.fillStrategy': 'outside_in', 'linking.entryType': 'ramp_linear' })
    expect(ramp).toContain('linking.rampAngle')
    expect(ramp).not.toContain('params.helixDiameter')
    expect(ramp).not.toContain('params.entryClearance')
    const plunge = keys({ ...base, 'linking.entryType': 'plunge' })
    expect(plunge).not.toContain('linking.rampAngle')
  })

  it('shows the finish and corner fields only when they apply', () => {
    const keys = (v: ParamValues) => opSchema.visibleParams(POCKET_SCHEMA, v).map(p => p.key)
    const base = opSchema.defaultsOf(POCKET_SCHEMA)
    expect(keys({ ...base, 'params.finishContour': false })).not.toContain('passes.finishPasses')
    expect(keys({ ...base, 'params.stayDown': true })).toContain('params.stayDownLift')
    expect(keys(base)).not.toContain('params.stayDownLift')
    expect(keys(base)).not.toContain('params.cornerReliefGentle')
    expect(keys({ ...base, 'params.cornerRelief': 'dogbone' })).toContain('params.cornerReliefGentle')
    expect(keys({ ...base, 'params.cornerRelief': 'dogbone', 'params.cornerReliefGentle': true })).toContain('params.cornerReliefEngagement')
    expect(keys({ ...base, 'params.boundarySource': 'stock' })).not.toContain('params.geometryId')
  })

  it('names a saved entry its fill strategy cannot run, and the entries it can', () => {
    const values = { ...opSchema.defaultsOf(POCKET_SCHEMA), 'params.fillStrategy': 'outside_in', 'linking.entryType': 'ramp_helical' }
    const issues = opSchema.validate(POCKET_SCHEMA, values)
    expect(issues.map(i => i.key)).toEqual(['linking.entryType'])
    expect(resolveMessage(issues[0].reason, issues[0].params)).toBe('Outside in cannot start with Helix: choose Profile ramp or Plunge')
  })

  it('reports a Pocket value outside the old limits by name', () => {
    const issues = opSchema.validate(POCKET_SCHEMA, { ...opSchema.defaultsOf(POCKET_SCHEMA), 'params.helixDiameter': 120 })
    expect(issues.map(i => resolveMessage(i.reason, i.params))).toEqual(['Helix diameter must be at most 95 %'])
  })
})

describe('WO-3283 Pocket edits store what the old editors store', () => {
  it('writes a parameter into the operation field the old editor writes', () => {
    const op = oldPocket()
    expect(applyEdit(POCKET_SCHEMA, op, 'params.slotFeedPercent', 60)).toEqual({ params: { ...op.params, slotFeedPercent: 60 } })
    expect(applyEdit(POCKET_SCHEMA, op, 'passes.stepdown', 1.5)).toEqual({ passes: { ...op.passes, stepdown: 1.5 } })
    expect(applyEdit(POCKET_SCHEMA, op, 'toolId', 't2')).toEqual({ toolId: 't2' })
  })

  it('starts the linking from the Properties panel fallback when the operation has none', () => {
    const op = oldPocket()
    expect(applyEdit(POCKET_SCHEMA, op, 'linking.rampAngle', 4)).toEqual({
      linking: { entryType: 'plunge', rampAngle: 4, rampLength: 5, leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height' },
    })
  })

  it('never stores a negative floor hop, like the Properties panel', () => {
    const op = freshPocket()
    expect(applyEdit(POCKET_SCHEMA, op, 'linking.floorHopMm', -2)).toEqual({ linking: { ...op.linking, floorHopMm: 0 } })
  })

  it('rounds a typed finish or spring pass count to a whole number, like the dialog', () => {
    const op = freshPocket()
    expect(applyEdit(POCKET_SCHEMA, op, 'passes.finishPasses', 2.6)).toEqual({ passes: { ...op.passes, finishPasses: 3 } })
  })

  it('changing the fill strategy moves the entry to one it allows, like the dialog', () => {
    const op = freshPocket()
    expect(applyEdit(POCKET_SCHEMA, op, 'params.fillStrategy', 'outside_in')).toEqual({
      params: { ...op.params, fillStrategy: 'outside_in' },
      linking: { ...op.linking, entryType: 'ramp_linear' },
    })
    const plunge = { ...op, linking: { ...op.linking, entryType: 'plunge' } }
    expect(applyEdit(POCKET_SCHEMA, plunge, 'params.fillStrategy', 'outside_in')).toEqual({
      params: { ...op.params, fillStrategy: 'outside_in' },
    })
  })

  it('on a new Pocket, the fill strategy also sets stay-down the way the dialog does', () => {
    const op = freshPocket()
    expect(applyEdit(POCKET_SCHEMA, op, 'params.fillStrategy', 'outside_in', { creating: true })).toEqual({
      params: { ...op.params, fillStrategy: 'outside_in', stayDown: true, stayDownLift: 1 },
      linking: { ...op.linking, entryType: 'ramp_linear' },
    })
  })

  it('choosing the stock as the boundary clears the picked geometry, like the dialog', () => {
    const op = oldPocket()
    expect(applyEdit(POCKET_SCHEMA, op, 'params.boundarySource', 'stock')).toEqual({
      params: { ...op.params, boundarySource: 'stock', geometryId: '', loopIds: [], heightReference: 'stock_top', planeOffset: 0 },
    })
  })

  it('choosing the picked geometry puts the bottom on it and updates the height intent, like the dialog', () => {
    const op: PocketOp = { ...oldPocket(), params: { ...oldPocket().params, boundarySource: 'stock', heightReference: 'stock_top', planeOffset: 0 }, heights: { ...defaultHeights } }
    const params = { ...op.params, boundarySource: 'geometry', heightReference: 'geometry_face', planeOffset: 0 }
    expect(applyEdit(POCKET_SCHEMA, op, 'params.boundarySource', 'geometry')).toEqual({
      params,
      heights: { ...defaultHeights, ...deriveHeightPlaneOffsetUpdate('pocket_2d', defaultHeights, { heightReference: 'geometry_face', planeOffset: 0 }, 'geometry_face', 0) },
    })
  })

  it('reading back an edited operation shows the edit', () => {
    const op = freshPocket()
    const patch = applyEdit(POCKET_SCHEMA, op, 'params.cornerRelief', 't_bone')
    expect(readValues(POCKET_SCHEMA, { ...op, ...patch })['params.cornerRelief']).toBe('t_bone')
  })
})

// ------------------------------------------------------------------------------- renderer
describe('WO-3283 renderer', () => {
  /** Draws the Pocket card and opens the sections that start folded (spec 6.4). */
  const draw = (values: ParamValues, onChange = vi.fn(), readOnly = false) => {
    const view = render(<OpSchemaForm schema={POCKET_SCHEMA} values={values} onChange={onChange} readOnly={readOnly} />)
    for (const header of view.container.querySelectorAll('[data-kit="Section"] > button[aria-expanded="false"]')) fireEvent.click(header)
    return view
  }

  it('folds the rarely changed fields: a whole group, or an Advanced section inside a mixed one', () => {
    const { container } = render(<OpSchemaForm schema={POCKET_SCHEMA} values={opSchema.defaultsOf(POCKET_SCHEMA)} onChange={vi.fn()} />)
    const folded = [...container.querySelectorAll('[data-kit="Section"][data-open="false"]')].map(e => e.getAttribute('data-testid'))
    expect(folded).toEqual(['opschema-advanced-passes', 'opschema-group-custom:corners'])
    expect(screen.queryByRole('radiogroup', { name: 'Fill strategy' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Stepdown' })).toBeTruthy()
  })

  it('opens a folded section when a field in it has a reason to show', () => {
    render(<OpSchemaForm schema={POCKET_SCHEMA} values={{ ...opSchema.defaultsOf(POCKET_SCHEMA), 'params.overlapMm': 30 }} onChange={vi.fn()} />)
    expect(screen.getByRole('alert').textContent).toBe('Ring overlap must be at most 20 mm')
  })

  it('offers the entry choices the fill strategy runs', () => {
    draw(opSchema.defaultsOf(POCKET_SCHEMA))
    const entry = screen.getByRole('radiogroup', { name: 'Entry type' })
    expect(within(entry).getAllByRole('radio').map(r => r.textContent)).toEqual(['Plunge', 'Helix'])
  })

  it('uses the tool limits when the screen gives the tool', () => {
    const values = { ...opSchema.defaultsOf(POCKET_SCHEMA), 'params.cornerRelief': 'dogbone', 'params.cornerReliefGentle': true, 'params.cornerReliefEngagement': 4 }
    render(<OpSchemaForm schema={POCKET_SCHEMA} values={values} onChange={vi.fn()} context={{ toolDiameter: 6 }} />)
    expect(screen.getByRole('alert').textContent).toBe('Max engagement must be at most 3 mm')
  })

  it('draws one section per group in spec 6.4 order, with the kit parts', () => {
    const { container } = draw(opSchema.defaultsOf(POCKET_SCHEMA))
    const captions = [...container.querySelectorAll('[data-kit="Section"] > button > span:first-child')].map(e => e.textContent)
    expect(captions).toEqual(['Tool', 'Geometry', 'Passes', 'Advanced', 'Linking', 'Feeds', 'Corners'])
    expect(screen.getByRole('textbox', { name: 'Stepdown' }).closest('[data-kit="NumberField"]')).not.toBeNull()
    expect(screen.getByRole('radiogroup', { name: 'Milling direction' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Corner relief' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Finish contour pass on the pocket wall' })).toBeTruthy()
  })

  it('does not draw a hidden parameter', () => {
    draw({ ...opSchema.defaultsOf(POCKET_SCHEMA), 'linking.entryType': 'plunge' })
    expect(screen.queryByRole('textbox', { name: 'Ramp angle' })).toBeNull()
  })

  it('leaves the tool and geometry pickers a slot to fill', () => {
    const { container } = draw(opSchema.defaultsOf(POCKET_SCHEMA))
    expect([...container.querySelectorAll('[data-opschema-slot]')].map(e => e.getAttribute('data-opschema-slot'))).toEqual(['toolId', 'params.geometryId'])
  })

  it('reports each edit with the parameter key and the stored value', () => {
    const onChange = vi.fn()
    draw(opSchema.defaultsOf(POCKET_SCHEMA), onChange)
    const stepdown = screen.getByRole('textbox', { name: 'Stepdown' })
    fireEvent.change(stepdown, { target: { value: '3.5' } })
    fireEvent.blur(stepdown)
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Milling direction' })).getByRole('radio', { name: 'Conventional' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Finish contour pass on the pocket wall' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Corner relief' }), { target: { value: 'dogbone' } })
    expect(onChange.mock.calls).toEqual([
      ['passes.stepdown', 3.5],
      ['params.direction', 'conventional'],
      ['params.finishContour', false],
      ['params.cornerRelief', 'dogbone'],
    ])
  })

  it('shows the reason beside a field whose value the software cannot run', () => {
    draw({ ...opSchema.defaultsOf(POCKET_SCHEMA), 'params.helixDiameter': 120 })
    expect(screen.getByRole('alert').textContent).toBe('Helix diameter must be at most 95 %')
  })

  it('disables every field while the operation cannot be edited', () => {
    const onChange = vi.fn()
    const { container } = draw(opSchema.defaultsOf(POCKET_SCHEMA), onChange, true)
    const fields = [...container.querySelectorAll('input, select, [role="radio"]')] as HTMLInputElement[]
    expect(fields.length).toBeGreaterThan(10)
    // WO-3278's kit inputs show "cannot edit" as the unavailable state (aria-disabled + reason), not the native attribute.
    expect(fields.filter(f => !f.disabled && f.getAttribute('aria-disabled') !== 'true')).toEqual([])
    const text = fields.find(f => f.tagName === 'INPUT' && f.type !== 'checkbox' && f.type !== 'radio')!
    fireEvent.change(text, { target: { value: '9' } })
    fireEvent.blur(text)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('draws list items with their own fields and reports the whole list on an edit', () => {
    const onChange = vi.fn()
    render(<OpSchemaForm schema={sample} values={opSchema.defaultsOf(sample)} onChange={onChange} />)
    const items = screen.getAllByRole('group', { name: /Stepdown 1/ })
    expect(items).toHaveLength(1)
    const field = within(items[0]).getAllByRole('textbox')[1]
    fireEvent.change(field, { target: { value: '25' } })
    fireEvent.blur(field)
    expect(onChange).toHaveBeenLastCalledWith('steps', [{ d: 6, l: 25 }])
  })

  it('gives an issue the field name and limit through one helper', () => {
    const issue: ParamIssue = opSchema.validate(sample, { ...opSchema.defaultsOf(sample), depth: 40 })[0]
    expect(issueMessage(issue)).toBe('Stepdown must be at most 30 mm')
  })

  it('imports no CAM, kernel or wasm code', async () => {
    const { isEngineSource } = (await import(/* @vite-ignore */ pathToFileURL(join(ROOT, 'tools/ui-debt.mjs')).href)) as { isEngineSource(spec: string): boolean }
    const dir = join(ROOT, 'src/components/opschema')
    const files = readdirSync(dir).filter(f => /\.tsx?$/.test(f))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8')
      const specs = [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(m => m[1])
      expect(specs.filter(s => isEngineSource(s) || /opschema\/schemas/.test(s))).toEqual([])
    }
  })
})

// ------------------------------------------------------------------------------- words
describe('WO-3283 words', () => {
  const keysOf = (tree: unknown, prefix = ''): string[] =>
    Object.entries(tree as Record<string, unknown>).flatMap(([k, v]) => typeof v === 'string' ? [prefix + k] : keysOf(v, `${prefix}${k}.`))

  it('has an English text for every word the Pocket schema and the checks use', () => {
    const english = ENGLISH_CATALOG[AREA]
    expect(english).toBeDefined()
    const keys = new Set(keysOf(english))
    const used = POCKET_SCHEMA.params.flatMap(p => [p.labelKey, p.helpKey, ...(p.choices ?? []).map(c => c.labelKey)])
      .filter((k): k is NonNullable<typeof k> => k !== undefined)
    expect(used.length).toBeGreaterThan(40)
    expect(used.filter(k => !k.startsWith(`${AREA}:`) || !keys.has(k.slice(AREA.length + 1)))).toEqual([])
  })

  it('has the same keys in German, Spanish and French', async () => {
    const en = keysOf((await import('../../i18n/locales/en/ui2-opschema.wo3283')).default).sort()
    for (const lang of ['de', 'es', 'fr']) {
      const other = (await import(`../../i18n/locales/${lang}/ui2-opschema.wo3283.ts`)).default
      expect(keysOf(other).sort()).toEqual(en)
    }
  })
})
