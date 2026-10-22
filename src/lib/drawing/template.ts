// WO-3006 (WO-2750 Slice E): the editable title block and general tolerance
// table a drawing carries.
//
// docs/design/ASSOCIATIVE-TECHNICAL-DRAWINGS.md section 6 gives the starter
// instance this file makes real: a Letter (or A4) landscape sheet in mm, a
// 110 x 35 mm title block in the bottom right corner and a movable general
// tolerance block beside it. The template is COPIED into the drawing
// (DrawingDocument.template), so editing it changes only that drawing and a
// later change to these starters never touches a drawing already made.
//
// Rules kept here (plan section 6):
//  - Bound fields (title, created, drawing edited, model edited) follow their
//    source; an override is literal, marked, and never overwritten by a refresh.
//  - Model edits move `sourceEditedAt`; drawing annotation/layout/template
//    edits move `editedAt`. Opening never moves either (the editor writes
//    neither on open).
//  - Drawn-by is typed by the operator; it is metadata, not a sign-in claim.
//  - General tolerances apply only to dimensions that opt in, and such a
//    dimension pins the value it took; editing the table never changes it
//    behind the operator's back (annotations.ts).
//
// Plain data only; no React, no kernel.

import type { DrawingDocument, DrawingGeneralTolerances, DrawingTemplateSnapshot } from './document'

export const STARTER_TEMPLATE_ID = 'starter-landscape-mm'
export const STARTER_TEMPLATE_REVISION = '1'

/** Plan section 6: "UNLESS OTHERWISE SPECIFIED (mm; degrees)", 0.5 / 0.1 / 0.05 mm by decimals, 0.5 degrees. */
export function starterGeneralTolerances(): DrawingGeneralTolerances {
  return { linearByDecimalPlaces: { '0': 0.5, '1': 0.1, '2': 0.05, '3': 0.01 }, angularDegrees: 0.5 }
}

/** The zone dates are shown in (plan section 6 example). */
export const STARTER_DATE_ZONE = 'America/Chicago'

/** The starter template, copied into every new drawing. Text fields start blank or at their usual first value. */
export function starterTemplate(): DrawingTemplateSnapshot {
  return {
    templateId: STARTER_TEMPLATE_ID,
    revision: STARTER_TEMPLATE_REVISION,
    fields: { partNumber: '', revision: 'A', drawnBy: '', branding: 'YOUR SHOP' },
    overrides: {},
    assetIds: [],
    generalTolerances: starterGeneralTolerances(),
    dateDisplayZone: STARTER_DATE_ZONE,
  }
}

/**
 * The template as the editor uses it. A drawing made before this slice
 * carries the blank snapshot; it reads as the starter with its own fields
 * kept (ADR-0040: a default, no migration).
 */
export function effectiveTemplate(snapshot: DrawingTemplateSnapshot): Required<Pick<DrawingTemplateSnapshot, 'generalTolerances' | 'dateDisplayZone' | 'overrides'>> & DrawingTemplateSnapshot {
  const starter = starterTemplate()
  return {
    ...snapshot,
    fields: snapshot.templateId === 'blank' ? { ...starter.fields, ...snapshot.fields } : snapshot.fields,
    overrides: snapshot.overrides ?? {},
    generalTolerances: snapshot.generalTolerances ?? starter.generalTolerances!,
    dateDisplayZone: snapshot.dateDisplayZone ?? STARTER_DATE_ZONE,
  }
}

// ---------------------------------------------------------------------------
// Layout (sheet mm, origin top-left, Y down)
// ---------------------------------------------------------------------------

export const TITLE_BLOCK_SIZE_MM: [number, number] = [110, 35]
export const TOLERANCE_BLOCK_SIZE_MM: [number, number] = [140, 35]

/** The title block's rectangle: bottom right inside the margin (plan section 6: [159.4, 170.9, 110, 35] on Letter). */
export function titleBlockRect(sizeMm: [number, number], marginMm: number): [number, number, number, number] {
  return [sizeMm[0] - marginMm - TITLE_BLOCK_SIZE_MM[0], sizeMm[1] - marginMm - TITLE_BLOCK_SIZE_MM[1], TITLE_BLOCK_SIZE_MM[0], TITLE_BLOCK_SIZE_MM[1]]
}

/** The general tolerance block's rectangle: bottom left inside the margin (plan section 6: [10, 170.9, 140, 35]). */
export function toleranceBlockRect(sizeMm: [number, number], marginMm: number): [number, number, number, number] {
  return [marginMm, sizeMm[1] - marginMm - TOLERANCE_BLOCK_SIZE_MM[1], TOLERANCE_BLOCK_SIZE_MM[0], TOLERANCE_BLOCK_SIZE_MM[1]]
}

export type TitleFieldKey = 'title' | 'partNumber' | 'revision' | 'drawnBy' | 'created' | 'drawingEdited' | 'modelEdited' | 'branding' | 'scale'

/** Where a field takes its text from when it is not overridden. */
export type TitleFieldBinding = 'source.displayName' | 'drawing.createdDate' | 'drawing.editedDate' | 'source.editedDate' | 'sheet.scale' | 'literal'

export interface TitleFieldSpec {
  key: TitleFieldKey
  binding: TitleFieldBinding
  /** local to the title block, mm */
  rectMm: [number, number, number, number]
}

/** Plan section 6 field rectangles, plus the scale as a bound system field. */
export const TITLE_FIELDS: readonly TitleFieldSpec[] = Object.freeze([
  { key: 'title', binding: 'source.displayName', rectMm: [2, 2, 106, 6] },
  { key: 'partNumber', binding: 'literal', rectMm: [2, 9, 52, 6] },
  { key: 'revision', binding: 'literal', rectMm: [56, 9, 24, 6] },
  { key: 'branding', binding: 'literal', rectMm: [82, 9, 26, 6] },
  { key: 'drawnBy', binding: 'literal', rectMm: [2, 16, 52, 6] },
  { key: 'created', binding: 'drawing.createdDate', rectMm: [56, 16, 52, 6] },
  { key: 'drawingEdited', binding: 'drawing.editedDate', rectMm: [2, 23, 52, 6] },
  { key: 'modelEdited', binding: 'source.editedDate', rectMm: [56, 23, 52, 6] },
  { key: 'scale', binding: 'sheet.scale', rectMm: [2, 30, 52, 4] },
] as const satisfies readonly TitleFieldSpec[])

/** Fields the operator types (no binding). */
export const LITERAL_TITLE_FIELDS: readonly TitleFieldKey[] = TITLE_FIELDS.filter((f) => f.binding === 'literal').map((f) => f.key)
/** Fields that follow the part or the drawing unless overridden. */
export const BOUND_TITLE_FIELDS: readonly TitleFieldKey[] = TITLE_FIELDS.filter((f) => f.binding !== 'literal' && f.binding !== 'sheet.scale').map((f) => f.key)

/** A stored instant shown as a calendar date in `zone`. Empty when there is no date. */
export function formatDrawingDate(iso: string | undefined, zone: string): string {
  if (iso === undefined || iso === '') return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
  } catch {
    // An unknown zone name: show the date in UTC rather than nothing.
    return at.toISOString().slice(0, 10)
  }
}

export interface TitleFieldValue {
  key: TitleFieldKey
  rectMm: [number, number, number, number]
  text: string
  /** true when an override replaces the bound value */
  overridden: boolean
}

/** Every title block field's text for a drawing. `partName` is the source's display name in the Model tree. */
export function titleBlockValues(doc: DrawingDocument, partName: string): TitleFieldValue[] {
  const template = effectiveTemplate(doc.template)
  const zone = template.dateDisplayZone
  const scale = doc.sheets[0]?.views.find((v) => v.detail === undefined)?.scale
  return TITLE_FIELDS.map((spec) => {
    const override = template.overrides[spec.key]
    let bound: string
    switch (spec.binding) {
      case 'source.displayName': bound = partName; break
      case 'drawing.createdDate': bound = formatDrawingDate(doc.createdAt, zone); break
      case 'drawing.editedDate': bound = formatDrawingDate(doc.editedAt, zone); break
      case 'source.editedDate': bound = formatDrawingDate(doc.sourceEditedAt, zone); break
      case 'sheet.scale': bound = scale === undefined ? '' : `${scale.numerator}:${scale.denominator}`; break
      default: bound = template.fields[spec.key] ?? ''
    }
    const overridden = spec.binding !== 'literal' && override !== undefined
    return { key: spec.key, rectMm: spec.rectMm, text: overridden ? override : bound, overridden }
  })
}

function withTemplate(doc: DrawingDocument, template: DrawingTemplateSnapshot, now: string | undefined): DrawingDocument {
  return { ...doc, template, editedAt: now ?? doc.editedAt }
}

/** Set a typed field (part number, revision, drawn by, branding text). A drawing edit: `editedAt` moves. */
export function setTemplateField(doc: DrawingDocument, key: TitleFieldKey, value: string, now?: string): DrawingDocument {
  const t = effectiveTemplate(doc.template)
  return withTemplate(doc, { ...t, fields: { ...t.fields, [key]: value } }, now)
}

/** Override a bound field with literal text, or (null) let it follow its source again. */
export function setTemplateOverride(doc: DrawingDocument, key: TitleFieldKey, value: string | null, now?: string): DrawingDocument {
  const t = effectiveTemplate(doc.template)
  const overrides = { ...t.overrides }
  if (value === null) delete overrides[key]
  else overrides[key] = value
  return withTemplate(doc, { ...t, overrides }, now)
}

/**
 * Edit the general tolerance table. The template's revision moves so a
 * dimension pinned to the old value can say so; pinned values stay as they
 * were (annotations.ts updateGeneralTolerance is the explicit update).
 */
export function setGeneralTolerances(doc: DrawingDocument, next: DrawingGeneralTolerances, now?: string): DrawingDocument {
  const t = effectiveTemplate(doc.template)
  const revision = String((Number.parseInt(t.revision, 10) || 0) + 1)
  return withTemplate(doc, { ...t, revision, generalTolerances: { linearByDecimalPlaces: { ...next.linearByDecimalPlaces }, angularDegrees: next.angularDegrees } }, now)
}

/** The general tolerance the table gives a dimension shown at `precision` decimals (linear) or for an angle. */
export function generalToleranceValue(tables: DrawingGeneralTolerances, measurement: 'linear' | 'angle' | 'radius' | 'diameter', precision: number): number | undefined {
  if (measurement === 'angle') return tables.angularDegrees
  const places = Math.max(0, Math.min(6, Math.round(precision)))
  const exact = tables.linearByDecimalPlaces[String(places)]
  if (exact !== undefined) return exact
  // More decimals than the table lists: use the tightest row it has.
  const rows = Object.entries(tables.linearByDecimalPlaces).map(([k, v]) => [Number(k), v] as const).filter(([k]) => k <= places).sort((a, b) => b[0] - a[0])
  return rows[0]?.[1]
}
