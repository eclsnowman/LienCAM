// WO-3006 (WO-2750 Slice E): the editable title block and general tolerance
// table - docs/design/ASSOCIATIVE-TECHNICAL-DRAWINGS.md section 8 row
// "Template edit and units/precision": explicit limits and a pinned general
// tolerance survive (here: through the archive's own write/read); changing
// the default library leaves a saved instance intact; drawn-by and the
// edit-date rules hold. The same row through the real Model page and a real
// project save is in src/tests/model3d/drawingRepair.wo2750.test.tsx.

import { describe, expect, it } from 'vitest'
import {
  createDrawingDocument,
  readDrawingRecords,
  writeDrawingRecords,
  type DrawingDimension,
  type DrawingDocument,
} from '../../lib/drawing/document'
import {
  BOUND_TITLE_FIELDS,
  LITERAL_TITLE_FIELDS,
  effectiveTemplate,
  formatDrawingDate,
  generalToleranceValue,
  setGeneralTolerances,
  setTemplateField,
  setTemplateOverride,
  starterTemplate,
  titleBlockRect,
  titleBlockValues,
  toleranceBlockRect,
} from '../../lib/drawing/template'
import { generalToleranceFor, generalToleranceUpdate, setSheetUnits, updateAnnotation } from '../../lib/drawing/annotations'
import { standardViewFrame } from '../../lib/drawing/project'
import type { JsonValue } from '../../doc/persist/stable-json'

const REV = { geometryFingerprint: 'g1', frameFingerprint: 'body-local', producerVersion: 'p' }

function newDoc(): DrawingDocument {
  return createDrawingDocument({
    id: 'drawing-1',
    name: 'Drawing of Block',
    source: { modelItemId: 'legacy', documentId: 'doc', lineageId: 'F1', kind: 'model-brep', observedRevision: REV },
    frames: { front: standardViewFrame('front'), top: standardViewFrame('top'), right: standardViewFrame('right'), iso: standardViewFrame('iso') },
    box: { min: [0, 0, 0], max: [60, 40, 100] },
    now: '2026-10-21T04:00:00.000Z',
  })
}

function withDimension(doc: DrawingDocument): DrawingDocument {
  const dim: DrawingDimension = { kind: 'dimension', id: 'dim-1', measurement: 'linear', referenceIds: [], tolerance: { kind: 'none' }, viewId: 'view-front', labelSheetMm: [20, 40] }
  return { ...doc, annotations: [dim] }
}

function roundTrip(doc: DrawingDocument): DrawingDocument {
  const json = JSON.parse(JSON.stringify(writeDrawingRecords({ documents: [doc], preserved: [] }))) as JsonValue
  return readDrawingRecords(json).documents[0]
}

describe('WO-3006 starter template (plan section 6)', () => {
  it('places the title block and tolerance block where the plan puts them on Letter, and keeps them in the corner on A4', () => {
    expect(titleBlockRect([279.4, 215.9], 10).map((v) => Number(v.toFixed(3)))).toEqual([159.4, 170.9, 110, 35])
    expect(toleranceBlockRect([279.4, 215.9], 10).map((v) => Number(v.toFixed(3)))).toEqual([10, 170.9, 140, 35])
    expect(titleBlockRect([297, 210], 10)).toEqual([177, 165, 110, 35])
  })

  it('a new drawing carries its own copy: changing the library default never touches it', () => {
    const doc = newDoc()
    expect(doc.template.templateId).toBe('starter-landscape-mm')
    expect(doc.template.generalTolerances).toEqual({ linearByDecimalPlaces: { '0': 0.5, '1': 0.1, '2': 0.05, '3': 0.01 }, angularDegrees: 0.5 })
    expect(doc.template.dateDisplayZone).toBe('America/Chicago')
    const library = starterTemplate()
    library.generalTolerances!.linearByDecimalPlaces['2'] = 0.2
    library.fields.drawnBy = 'someone'
    expect(doc.template.generalTolerances!.linearByDecimalPlaces['2']).toBe(0.05)
    expect(doc.template.fields.drawnBy).toBe('')
    expect(starterTemplate().generalTolerances!.linearByDecimalPlaces['2']).toBe(0.05)
  })

  it('reads a drawing made before this slice (blank template) as the starter, keeping its own fields', () => {
    const t = effectiveTemplate({ templateId: 'blank', revision: '0', fields: { drawnBy: 'A. Machinist' }, assetIds: [] })
    expect(t.fields).toMatchObject({ drawnBy: 'A. Machinist', revision: 'A' })
    expect(t.generalTolerances.angularDegrees).toBe(0.5)
    expect(t.overrides).toEqual({})
  })

  it('lists the typed and the bound fields', () => {
    expect(LITERAL_TITLE_FIELDS).toEqual(['partNumber', 'revision', 'branding', 'drawnBy'])
    expect(BOUND_TITLE_FIELDS).toEqual(['title', 'created', 'drawingEdited', 'modelEdited'])
  })
})

describe('WO-3006 title block fields and dates', () => {
  it('bound fields follow the part; an override is literal, marked, and survives a refresh until cleared', () => {
    let doc = newDoc()
    const title = () => titleBlockValues(doc, 'Block').find((f) => f.key === 'title')!
    expect(title()).toMatchObject({ text: 'Block', overridden: false })
    doc = setTemplateOverride(doc, 'title', 'Mounting block', '2026-10-21T05:00:00.000Z')
    expect(title()).toMatchObject({ text: 'Mounting block', overridden: true })
    // The part is renamed: the override stays.
    expect(titleBlockValues(doc, 'Block v2').find((f) => f.key === 'title')).toMatchObject({ text: 'Mounting block', overridden: true })
    doc = setTemplateOverride(doc, 'title', null, '2026-10-21T05:01:00.000Z')
    expect(titleBlockValues(doc, 'Block v2').find((f) => f.key === 'title')).toMatchObject({ text: 'Block v2', overridden: false })
  })

  it('drawn-by is typed; drawing edits move editedAt only; dates show in the template zone', () => {
    let doc = newDoc()
    doc = setTemplateField(doc, 'drawnBy', 'A. Machinist', '2026-10-21T05:00:00.000Z')
    expect(doc.template.fields.drawnBy).toBe('A. Machinist')
    expect(doc.editedAt).toBe('2026-10-21T05:00:00.000Z')
    expect(doc.createdAt).toBe('2026-10-21T04:00:00.000Z')
    expect(doc.sourceEditedAt).toBeUndefined()
    // 04:00 UTC on the 21st is the 20th in Chicago.
    const v = titleBlockValues({ ...doc, sourceEditedAt: '2026-10-22T12:00:00.000Z' }, 'Block')
    expect(v.find((f) => f.key === 'created')!.text).toBe('2026-10-20')
    expect(v.find((f) => f.key === 'drawingEdited')!.text).toBe('2026-10-21')
    expect(v.find((f) => f.key === 'modelEdited')!.text).toBe('2026-10-22')
    expect(v.find((f) => f.key === 'drawnBy')!.text).toBe('A. Machinist')
    expect(v.find((f) => f.key === 'scale')!.text).toMatch(/^\d+:\d+$/)
    expect(formatDrawingDate(undefined, 'America/Chicago')).toBe('')
    expect(formatDrawingDate('2026-10-21T04:00:00.000Z', 'Not/AZone')).toBe('2026-10-21')
  })
})

describe('WO-3006 general tolerances and units', () => {
  it('a general dimension pins the value it took; a table edit changes the revision, not the pin, and offers an update', () => {
    let doc = withDimension(newDoc())
    const dim = () => doc.annotations[0] as DrawingDimension
    doc = updateAnnotation(doc, 'dim-1', { tolerance: generalToleranceFor(doc, dim(), 2) })
    expect(dim().tolerance).toEqual({ kind: 'general', tableKey: '2', templateRevision: '1', value: 0.05 })
    expect(generalToleranceUpdate(doc, dim(), 2)).toBeNull()
    doc = setGeneralTolerances(doc, { ...doc.template.generalTolerances!, linearByDecimalPlaces: { ...doc.template.generalTolerances!.linearByDecimalPlaces, '2': 0.02 } }, '2026-10-21T06:00:00.000Z')
    expect(doc.template.revision).toBe('2')
    expect(dim().tolerance).toEqual({ kind: 'general', tableKey: '2', templateRevision: '1', value: 0.05 })
    expect(generalToleranceUpdate(doc, dim(), 2)).toEqual({ kind: 'general', tableKey: '2', templateRevision: '2', value: 0.02 })
    // Showing more decimals selects no new policy behind the operator's back.
    expect(dim().tolerance).toMatchObject({ value: 0.05 })
  })

  it('table rows: exact decimals, else the tightest row the table has; angles use the angular row', () => {
    const t = starterTemplate().generalTolerances!
    expect(generalToleranceValue(t, 'linear', 0)).toBe(0.5)
    expect(generalToleranceValue(t, 'diameter', 1)).toBe(0.1)
    expect(generalToleranceValue(t, 'linear', 4)).toBe(0.01)
    expect(generalToleranceValue(t, 'angle', 2)).toBe(0.5)
  })

  it('units and precision change what is shown, never the stored limits; everything survives the archive write/read', () => {
    let doc = withDimension(newDoc())
    doc = updateAnnotation(doc, 'dim-1', { tolerance: { kind: 'limits', lower: 99.95, upper: 100.1 } })
    doc = setSheetUnits(doc, 'sheet-1', 'inch', 3, '2026-10-21T07:00:00.000Z')
    expect(doc.sheets[0]).toMatchObject({ unit: 'inch', precision: 3 })
    expect((doc.annotations[0] as DrawingDimension).tolerance).toEqual({ kind: 'limits', lower: 99.95, upper: 100.1 })
    doc = setTemplateField(doc, 'drawnBy', 'A. Machinist')
    doc = setTemplateOverride(doc, 'title', 'Mounting block')
    doc = { ...doc, sourceEditedAt: '2026-10-21T08:00:00.000Z' }
    const back = roundTrip(doc)
    expect(back.template).toEqual(doc.template)
    expect(back.annotations).toEqual(doc.annotations)
    expect(back.sheets[0]).toMatchObject({ unit: 'inch', precision: 3 })
    expect(back.sourceEditedAt).toBe('2026-10-21T08:00:00.000Z')
    expect(back.editedAt).toBe(doc.editedAt)
    expect(back.createdAt).toBe(doc.createdAt)
  })
})
