// WO-2750 Slice B (WO-2987): the drawing documents a Model Item keeps in its
// project archive.
//
// docs/design/ASSOCIATIVE-TECHNICAL-DRAWINGS.md section 4.1 ("DrawingDocument has
// schemaVersion, id, source, timestamps, author, template snapshot, embedded
// assets, sheets[], references[], annotations[]"). types.ts (Slice A) owns the
// reference records; this file owns the document that holds them and the
// tolerant read/write that the archive (src/doc/persist/format.ts) and the
// holder (src/doc/documentHolder.ts) use.
//
// Plain JSON only. Nothing here touches the kernel, React or the store, so a
// project saved without ever mounting the Model workspace can still carry,
// re-emit and reopen its drawings.
//
// Three rules the read side keeps (plan section 7 row B):
//  - A field a file does not have takes a default; there is no migration
//    (ADR-0040, no legacy before 1.0).
//  - A drawing written by a NEWER build (schemaVersion above ours), or one whose
//    shape this build cannot read, is kept byte-for-byte as `preserved` and is
//    written back unchanged. It is never dropped and never rewritten.
//  - Fields this build does not know on a readable drawing ride along.

import type { JsonObject, JsonValue } from '../../doc/persist/stable-json'
import type { DrawingReference, DrawingSelector, DrawingSource, RationalScale, SourceRevision, ViewFrame } from './types'
import { starterTemplate } from './template'

export const DRAWING_DOCUMENT_SCHEMA_VERSION = 1

export type DrawingMeasurementKind = 'linear' | 'angle' | 'radius' | 'diameter'

/** Plan section 4.1: none | general (table key + pinned template revision) | bilateral | limits | reference. */
export type DrawingToleranceIntent =
  | { kind: 'none' }
  | {
      kind: 'general'
      tableKey: string
      templateRevision: string
      /** WO-3006: the +/- value the table gave when the dimension opted in; a later table edit leaves it until an explicit update */
      value?: number
    }
  | { kind: 'bilateral'; upper: number; lower: number }
  | { kind: 'limits'; lower: number; upper: number }
  | { kind: 'reference' }

/** An image or other file a drawing carries (branding, template art). Bytes are base64 so the drawing stays plain JSON. */
export interface DrawingAsset {
  id: string
  name: string
  contentType: string
  dataBase64: string
}

export interface DrawingAuthor {
  name?: string
}

/** WO-3006: plan section 6 general tolerance table: +/- mm by displayed decimal places, and degrees for angles. */
export interface DrawingGeneralTolerances {
  linearByDecimalPlaces: Record<string, number>
  angularDegrees: number
}

/** A pinned copy of the template a drawing was made from, so a later change to the default library leaves it intact. */
export interface DrawingTemplateSnapshot {
  templateId: string
  revision: string
  fields: Record<string, string>
  /** ids of `assets` the template draws (logo and the like) */
  assetIds: string[]
  /** WO-3006: literal text replacing a bound field (title, dates); never overwritten by a refresh */
  overrides?: Record<string, string>
  /** WO-3006: the table general-tolerance dimensions take their value from */
  generalTolerances?: DrawingGeneralTolerances
  /** WO-3006: IANA zone the title block shows dates in */
  dateDisplayZone?: string
}

export type DrawingViewAlignment = { parentViewId: string; axis: 'horizontal' | 'vertical' }

/** A round detail view crops in source space, never in screen pixels (plan section 4.1). */
export interface DrawingDetailCrop {
  parentViewId: string
  centerLocalMm: [number, number, number]
  radiusMm: number
  magnification: RationalScale
}

export interface DrawingView {
  id: string
  frame: ViewFrame
  scale: RationalScale
  /** sheet origin in mm, top-left, Y down */
  sheetOriginMm: [number, number]
  showHidden: boolean
  alignment?: DrawingViewAlignment
  detail?: DrawingDetailCrop
  /** WO-3006: the letter a detail view is called by ("A" -> circle A on the parent, DETAIL A under the view) */
  label?: string
}

export interface DrawingSheet {
  id: string
  sizeMm: [number, number]
  marginsMm: number
  projection: 'first-angle' | 'third-angle'
  unit: 'mm' | 'inch'
  precision: number
  views: DrawingView[]
}

export interface DrawingDimension {
  kind: 'dimension'
  id: string
  measurement: DrawingMeasurementKind
  /** ordered; see the reference's witness for the role each plays */
  referenceIds: string[]
  precision?: number
  prefix?: string
  suffix?: string
  /** sheet position of the label, mm */
  labelSheetMm?: [number, number]
  tolerance: DrawingToleranceIntent
  /** last value the resolver proved, kept as a cache with its provenance (plan section 4.2 step 7) */
  lastGood?: { value: number; unit: 'mm' | 'deg'; measuredAt: SourceRevision }
  /** WO-3006: the view the dimension is drawn in (its witnesses project through that view) */
  viewId?: string
  /** WO-3006: every explicit reassociation, oldest first (plan section 4.2: "records old/new selectors and revision") */
  repairs?: DrawingRepairRecord[]
}

/** One accepted repair of one dimension endpoint. */
export interface DrawingRepairRecord {
  at?: string
  referenceIndex: number
  oldReferenceId: string
  newReferenceId: string
  oldSelector: DrawingSelector
  newSelector: DrawingSelector
  /** the source revision the new reference was picked on */
  revision: SourceRevision
}

export interface DrawingBalloon {
  kind: 'balloon'
  id: string
  number: number
  text?: string
  anchorSheetMm: [number, number]
  /** WO-3006: where the numbered circle sits; the leader runs from it to the anchor */
  labelSheetMm?: [number, number]
  /** WO-3006: the view the balloon was placed on, when it was placed on one */
  viewId?: string
  /** geometry leader; absent for an explicit sheet anchor, which has no invented model association */
  referenceId?: string
}

export interface DrawingNote {
  kind: 'note'
  id: string
  text: string
  anchorSheetMm: [number, number]
  referenceId?: string
}

export type DrawingAnnotation = DrawingDimension | DrawingBalloon | DrawingNote

export interface DrawingDocument {
  schemaVersion: number
  id: string
  name: string
  source: DrawingSource
  createdAt?: string
  editedAt?: string
  /** WO-3006: the last time the part's geometry was seen to change (title block "model edited") */
  sourceEditedAt?: string
  author: DrawingAuthor
  template: DrawingTemplateSnapshot
  assets: DrawingAsset[]
  sheets: DrawingSheet[]
  references: DrawingReference[]
  annotations: DrawingAnnotation[]
  /** the source revision the whole drawing last proved current */
  lastGoodRevision?: SourceRevision
}

/**
 * Everything a Model Item keeps. `preserved` holds drawings this build cannot
 * read (a newer schemaVersion, or a shape it does not recognise), verbatim.
 */
export interface DrawingRecords {
  documents: DrawingDocument[]
  preserved: JsonValue[]
}

export const EMPTY_DRAWING_RECORDS: DrawingRecords = Object.freeze({ documents: [], preserved: [] }) as DrawingRecords

export function emptyDrawingRecords(): DrawingRecords {
  return { documents: [], preserved: [] }
}

/** True when there is nothing to write, so an archive without drawings stays byte-identical to one saved before this slice. */
export function drawingRecordsEmpty(records: DrawingRecords): boolean {
  return records.documents.length === 0 && records.preserved.length === 0
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function defaultTemplate(): DrawingTemplateSnapshot {
  return { templateId: 'blank', revision: '0', fields: {}, assetIds: [] }
}

function arrayOr<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/** The smallest shape a drawing needs to be scoped and kept: an id and a complete source. */
function hasReadableShape(raw: Record<string, unknown>): boolean {
  if (!isString(raw.id) || raw.id === '') return false
  const source = raw.source
  if (!isObject(source)) return false
  return isString(source.modelItemId) && isString(source.documentId) && isString(source.lineageId) && isString(source.kind)
}

/**
 * Read one drawing. Returns null when this build must keep it verbatim instead
 * (newer schemaVersion, or an unreadable shape). Absent fields take defaults.
 */
export function readDrawingDocument(raw: JsonValue): DrawingDocument | null {
  if (!isObject(raw)) return null
  const version = raw.schemaVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null
  if (version > DRAWING_DOCUMENT_SCHEMA_VERSION) return null
  if (!hasReadableShape(raw)) return null
  const template = isObject(raw.template) ? raw.template : {}
  return {
    ...(raw as unknown as DrawingDocument),
    name: isString(raw.name) ? raw.name : '',
    author: isObject(raw.author) ? (raw.author as DrawingAuthor) : {},
    template: {
      ...defaultTemplate(),
      ...(template as Partial<DrawingTemplateSnapshot>),
      fields: isObject(template.fields) ? (template.fields as Record<string, string>) : {},
      assetIds: arrayOr<string>(template.assetIds),
    },
    assets: arrayOr<DrawingAsset>(raw.assets),
    sheets: arrayOr<DrawingSheet>(raw.sheets),
    references: arrayOr<DrawingReference>(raw.references),
    annotations: arrayOr<DrawingAnnotation>(raw.annotations),
  }
}

/** Read the `documents` array an archive carries. Anything not an array reads as no drawings. */
export function readDrawingRecords(raw: JsonValue | undefined): DrawingRecords {
  const documentsRaw = isObject(raw) && Array.isArray(raw.documents) ? (raw.documents as JsonValue[]) : []
  const records = emptyDrawingRecords()
  for (const item of documentsRaw) {
    const document = readDrawingDocument(item)
    if (document === null) records.preserved.push(item)
    else records.documents.push(document)
  }
  return records
}

function sortKey(value: JsonValue): string {
  return isObject(value) && isString(value.id) ? value.id : JSON.stringify(value)
}

/**
 * The JSON an archive stores. Readable and preserved drawings are written
 * together, ordered by id, so the same records always make the same bytes.
 * Preserved entries are passed through exactly as they were read.
 */
export function writeDrawingRecords(records: DrawingRecords): JsonObject {
  const all = [...records.documents.map((d) => d as unknown as JsonValue), ...records.preserved]
  all.sort((a, b) => {
    const ka = sortKey(a)
    const kb = sortKey(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  return { documents: all }
}

// ---------------------------------------------------------------------------
// WO-2994 (WO-2750 Slice C): the editor's edits, as plain functions over the
// records, so the editor, the entry and the tests make the same documents.
// ---------------------------------------------------------------------------

/** The two starter sheets the operator approved (2026-10-20 card): landscape, mm. */
export type DrawingSheetSizeName = 'letter' | 'a4'

export const DRAWING_SHEET_SIZES: Readonly<Record<DrawingSheetSizeName, [number, number]>> = Object.freeze({
  letter: [279.4, 215.9],
  a4: [297, 210],
})

export const DRAWING_SHEET_MARGIN_MM = 10
/** Height kept free at the bottom of the sheet for the title block (plan section 6 puts it at y 170.9 on Letter). */
export const DRAWING_TITLE_BAND_MM = 35

/** Which starter size a sheet is, or null for a size this build did not make. */
export function sheetSizeName(sizeMm: [number, number]): DrawingSheetSizeName | null {
  for (const [name, size] of Object.entries(DRAWING_SHEET_SIZES) as Array<[DrawingSheetSizeName, [number, number]]>) {
    if (Math.abs(size[0] - sizeMm[0]) < 1e-6 && Math.abs(size[1] - sizeMm[1]) < 1e-6) return name
  }
  return null
}

/** Model-space box of the source when the drawing was laid out. */
export interface DrawingSourceBox {
  min: [number, number, number]
  max: [number, number, number]
}

/** The standard view a frame is, read from its `name`. */
export type DrawingViewName = 'front' | 'top' | 'right' | 'iso'

export const STANDARD_DRAWING_VIEWS: readonly DrawingViewName[] = ['front', 'top', 'right', 'iso']

const SCALE_STEPS: RationalScale[] = [
  { numerator: 10, denominator: 1 },
  { numerator: 5, denominator: 1 },
  { numerator: 2, denominator: 1 },
  { numerator: 1, denominator: 1 },
  { numerator: 1, denominator: 2 },
  { numerator: 1, denominator: 5 },
  { numerator: 1, denominator: 10 },
  { numerator: 1, denominator: 20 },
  { numerator: 1, denominator: 50 },
  { numerator: 1, denominator: 100 },
]

function frameExtent(frame: ViewFrame, box: DrawingSourceBox): [number, number] {
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) {
    const d = [x - frame.origin[0], y - frame.origin[1], z - frame.origin[2]]
    const u = d[0] * frame.xAxis[0] + d[1] * frame.xAxis[1] + d[2] * frame.xAxis[2]
    const v = d[0] * frame.upAxis[0] + d[1] * frame.upAxis[1] + d[2] * frame.upAxis[2]
    uMin = Math.min(uMin, u); uMax = Math.max(uMax, u); vMin = Math.min(vMin, v); vMax = Math.max(vMax, v)
  }
  return [uMax - uMin, vMax - vMin]
}

/** The four cells of the sheet a standard view sits in: third angle puts top above front and right beside it. */
function viewCells(sizeMm: [number, number], projection: DrawingSheet['projection']): Record<DrawingViewName, [number, number]> {
  const m = DRAWING_SHEET_MARGIN_MM
  const w = (sizeMm[0] - 2 * m) / 2
  const h = (sizeMm[1] - 2 * m - DRAWING_TITLE_BAND_MM) / 2
  const left = m + w / 2, right = m + w * 1.5, upper = m + h / 2, lower = m + h * 1.5
  return projection === 'third-angle'
    ? { top: [left, upper], front: [left, lower], right: [right, lower], iso: [right, upper] }
    : { top: [left, lower], front: [left, upper], right: [right, upper], iso: [right, lower] }
}

function cellSize(sizeMm: [number, number]): [number, number] {
  const m = DRAWING_SHEET_MARGIN_MM
  return [(sizeMm[0] - 2 * m) / 2, (sizeMm[1] - 2 * m - DRAWING_TITLE_BAND_MM) / 2]
}

/** The largest standard scale at which every view fits its cell with room to spare. */
export function fitDrawingScale(views: Array<{ frame: ViewFrame }>, box: DrawingSourceBox | null, sizeMm: [number, number]): RationalScale {
  if (box === null) return { numerator: 1, denominator: 1 }
  const [cw, ch] = cellSize(sizeMm)
  for (const step of SCALE_STEPS) {
    const k = step.numerator / step.denominator
    if (views.every(({ frame }) => {
      const [eu, ev] = frameExtent(frame, box)
      return eu * k <= cw * 0.8 && ev * k <= ch * 0.8
    })) return { ...step }
  }
  return { ...SCALE_STEPS[SCALE_STEPS.length - 1] }
}

/** Place the standard views on a sheet of `sizeMm`, keeping each view's frame. */
export function layoutStandardViews(views: DrawingView[], sizeMm: [number, number], projection: DrawingSheet['projection'], box: DrawingSourceBox | null): DrawingView[] {
  const cells = viewCells(sizeMm, projection)
  // WO-3006: a detail view is placed by the operator and follows its parent's
  // scale times its own magnification; it never takes a standard cell.
  const scale = fitDrawingScale(views.filter((v) => v.detail === undefined), box, sizeMm)
  const laid = views.map((view) => {
    const name = view.frame.name
    const cell = name !== undefined && view.detail === undefined ? cells[name] : undefined
    return cell === undefined ? view : { ...view, scale: { ...scale }, sheetOriginMm: [cell[0], cell[1]] as [number, number] }
  })
  return laid.map((view) => {
    if (view.detail === undefined) return view
    const parent = laid.find((p) => p.id === view.detail?.parentViewId)
    return parent === undefined ? view : { ...view, scale: multiplyScale(parent.scale, view.detail.magnification) }
  })
}

/** a x b as a reduced ratio. */
export function multiplyScale(a: RationalScale, b: RationalScale): RationalScale {
  const n = a.numerator * b.numerator
  const d = a.denominator * b.denominator
  const g = gcd(n, d)
  return { numerator: n / g, denominator: d / g }
}

function gcd(a: number, b: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b)) return 1
  let x = Math.abs(a), y = Math.abs(b)
  while (y) [x, y] = [y, x % y]
  return x || 1
}

export interface NewDrawingInput {
  id: string
  name: string
  source: DrawingSource
  /** frames for front/top/right/iso, all centred on the source box */
  frames: Record<DrawingViewName, ViewFrame>
  box: DrawingSourceBox | null
  sheetSize?: DrawingSheetSizeName
  now?: string
}

/** One sheet, Letter (or A4) landscape, third angle, mm, with front/top/right/iso. */
export function createDrawingDocument(input: NewDrawingInput): DrawingDocument {
  const sizeMm: [number, number] = [...DRAWING_SHEET_SIZES[input.sheetSize ?? 'letter']]
  const views: DrawingView[] = STANDARD_DRAWING_VIEWS.map((name) => ({
    id: `view-${name}`,
    frame: input.frames[name],
    scale: { numerator: 1, denominator: 1 },
    sheetOriginMm: [0, 0],
    showHidden: name !== 'iso',
  }))
  return {
    schemaVersion: DRAWING_DOCUMENT_SCHEMA_VERSION,
    id: input.id,
    name: input.name,
    source: input.source,
    createdAt: input.now,
    editedAt: input.now,
    author: {},
    // WO-3006: every new drawing gets its own copy of the starter title block.
    template: starterTemplate(),
    assets: [],
    sheets: [{
      id: 'sheet-1',
      sizeMm,
      marginsMm: DRAWING_SHEET_MARGIN_MM,
      projection: 'third-angle',
      unit: 'mm',
      precision: 2,
      views: layoutStandardViews(views, sizeMm, 'third-angle', input.box),
    }],
    references: [],
    annotations: [],
    lastGoodRevision: input.source.observedRevision,
  }
}

/** Change a sheet to another starter size and lay its standard views out again. A layout edit: the frames and the source are untouched. */
export function resizeDrawingSheet(doc: DrawingDocument, sheetId: string, size: DrawingSheetSizeName, box: DrawingSourceBox | null, now?: string): DrawingDocument {
  const sizeMm: [number, number] = [...DRAWING_SHEET_SIZES[size]]
  return {
    ...doc,
    editedAt: now ?? doc.editedAt,
    sheets: doc.sheets.map((sheet) => sheet.id !== sheetId ? sheet : {
      ...sheet,
      sizeMm,
      views: layoutStandardViews(sheet.views, sizeMm, sheet.projection, box),
    }),
  }
}

/** The records with `doc` added, or replacing the drawing with its id. Preserved entries ride along unchanged. */
export function putDrawingDocument(records: DrawingRecords, doc: DrawingDocument): DrawingRecords {
  const at = records.documents.findIndex((d) => d.id === doc.id)
  const documents = at < 0 ? [...records.documents, doc] : records.documents.map((d, i) => (i === at ? doc : d))
  return { documents, preserved: records.preserved }
}

/** The records without drawing `id`. Deleting a drawing never touches its part. */
export function removeDrawingDocument(records: DrawingRecords, id: string): DrawingRecords {
  return { documents: records.documents.filter((d) => d.id !== id), preserved: records.preserved }
}

/**
 * A drawing id no drawing of this item uses yet, and none of `reserved` (ids a
 * deleted drawing can still be restored under), so an id is never reused while
 * Undo can bring its drawing back.
 */
export function nextDrawingId(records: DrawingRecords, reserved: readonly string[] = []): string {
  const used = new Set([...records.documents.map((d) => d.id), ...records.preserved.map(sortKey), ...reserved])
  for (let n = 1; ; n++) if (!used.has(`drawing-${n}`)) return `drawing-${n}`
}

/**
 * The records with a deleted drawing put back. It never replaces a different
 * drawing: when its id is taken it comes back under a fresh id, beside the
 * drawing that holds it.
 */
export function restoreDrawingDocument(records: DrawingRecords, doc: DrawingDocument): { records: DrawingRecords; drawing: DrawingDocument } {
  const taken = records.documents.some((d) => d.id === doc.id) || records.preserved.some((p) => sortKey(p) === doc.id)
  const drawing = taken ? { ...doc, id: nextDrawingId(records) } : doc
  return { records: { documents: [...records.documents, drawing], preserved: records.preserved }, drawing }
}
