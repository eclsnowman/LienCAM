// Constraint browser list model (Stage 4, PLAN 3.5 "constraint browser
// list (click -> highlight, delete)").
//
// PURE: given the document and the effective solve status, build the
// grouped row list the BROWSER section renders. No React, no store —
// headless-testable, and the same row model feeds the over-defined
// conflict-resolution flow (the resolve panel lists the SAME rows,
// filtered to the solver-named sets).

import type {
  Sketch,
  SketchEntity,
  SketchConstraint,
  SketchConstraintKind,
  SketchDimension,
  SketchDimensionKind,
  SolveStatus,
} from './types'
import { constraintRefIds, dimensionRefIds } from './refIds'
import { constraintKindLabel } from './constraintActions'
import { pierceMissPhrase } from './projectLink'
import { DIMENSION_KINDS, UnknownSketchDimensionKindError } from './tools/dimTool'

// ---- Row status ------------------------------------------------------------

// Status precedence mirrors the solver layer: a constraint named in BOTH
// sets renders as conflicting (red wins over amber — conflicts are errors,
// redundancy is advisory).
export type BrowserRowStatus = 'ok' | 'conflicting' | 'redundant'

export interface BrowserRow {
  /** Document id of the constraint or dimension (= selection id). */
  id: string
  kind: SketchConstraintKind | SketchDimensionKind
  /** Human kind label ("Point on object", "Distance"). */
  label: string
  /** Operand entity labels ("Line 1, Line 2"), value-suffixed for dims. */
  operands: string
  isDimension: boolean
  /** Reference (driven) dimension — displayed parenthesized. */
  reference: boolean
  status: BrowserRowStatus
  /** WO-1865: set on a Pierce whose model edge has no crossing right now -- one plain sentence
   *  saying so. The point stays where it last was and the sketch still solves. */
  unresolved?: string
}

export interface BrowserGroup {
  kind: SketchConstraintKind | SketchDimensionKind
  title: string
  rows: BrowserRow[]
}

export interface BrowserModel {
  groups: BrowserGroup[]
  constraintCount: number
  dimensionCount: number
  conflictingCount: number
  redundantCount: number
  /** WO-1864: every projected piece's reference state, in document order. */
  references: BrowserReferenceRow[]
}

/** Where a projected piece's geometry comes from now (WO-1864):
 *  - 'linked'     follows its model source;
 *  - 'unresolved' linked, but the source could not be found on the last model change -- it keeps
 *                 its last resolved position, still solves and still bakes;
 *  - 'not-linked' a static copy (CAM-layer projection, pasted copy, broken link, edited piece). */
export type BrowserReferenceStatus = 'linked' | 'unresolved' | 'not-linked'

export interface BrowserReferenceRow {
  /** The projected entity's id (= selection id). */
  entityId: string
  /** "Line 3". */
  entityLabel: string
  /** The model source's name, when the piece is or was linked. */
  sourceLabel: string | null
  status: BrowserReferenceStatus
  /** One plain sentence for the row tooltip / flag. */
  detail: string
}

// ---- Entity labels -----------------------------------------------------------

// Entities have no user-facing names; label them "Line 1", "Circle 2", ...
// by per-kind counters in DOCUMENT ORDER so labels are stable across
// rebuilds of the same document (ids stay hidden — they mean nothing to
// the user).
const ENTITY_KIND_LABEL: Record<SketchEntity['kind'], string> = {
  point: 'Point',
  line: 'Line',
  arc: 'Arc',
  circle: 'Circle',
  ellipse: 'Ellipse',
  'elliptical-arc': 'Elliptical Arc',
  spline: 'Spline',
  text: 'Text',
  block: 'Block',
}

export function entityLabels(entities: readonly SketchEntity[]): Map<string, string> {
  const counters: Record<string, number> = {}
  const labels = new Map<string, string>()
  for (const e of entities) {
    const n = (counters[e.kind] = (counters[e.kind] ?? 0) + 1)
    labels.set(e.id, `${ENTITY_KIND_LABEL[e.kind]} ${n}`)
  }
  return labels
}

// ---- Rows --------------------------------------------------------------------

function refsLabel(ids: string[], labels: Map<string, string>): string {
  // Dedupe: a line-length distance references the same entity twice
  // (start + end sites) but reads as ONE operand. A reference to a
  // deleted entity cannot exist (delete cascades), but fail soft in
  // display code anyway.
  return [...new Set(ids)].map((id) => labels.get(id) ?? '?').join(', ')
}

function rowStatus(
  id: string,
  conflicting: ReadonlySet<string>,
  redundant: ReadonlySet<string>,
): BrowserRowStatus {
  if (conflicting.has(id)) return 'conflicting'
  if (redundant.has(id)) return 'redundant'
  return 'ok'
}

function formatDimValue(d: SketchDimension): string {
  // Angles are stored in radians; display degrees (matches the dim labels).
  let text: string
  switch (d.kind) {
    case 'angle':
    case 'angle3':
      text = `${parseFloat(((d.value * 180) / Math.PI).toFixed(3))} deg`
      break
    case 'distance':
    case 'distanceX':
    case 'distanceY':
    case 'ordinate':
    case 'distancePL':
    case 'radius':
    case 'diameter':
    case 'arcLength':
    case 'majorRadius':
    case 'minorRadius':
    case 'focusDistance':
      text = `${parseFloat(d.value.toFixed(3))} mm`
      break
    // REFERENCE-ONLY chamfer setback pair (UI-50C): both values, browser-row
    // convention (mm, 3dp) -- never the bare-d1 default other kinds share.
    case 'd1xd2':
      text = `${parseFloat(d.value.toFixed(3))} x ${parseFloat(d.d2.toFixed(3))} mm`
      break
    default:
      throw new UnknownSketchDimensionKindError((d as SketchDimension).kind)
  }
  return d.driving ? text : `(${text})`
}

function constraintRow(
  c: SketchConstraint,
  labels: Map<string, string>,
  conflicting: ReadonlySet<string>,
  redundant: ReadonlySet<string>,
): BrowserRow {
  const row: BrowserRow = {
    id: c.id,
    kind: c.kind,
    label: constraintKindLabel(c.kind),
    operands: refsLabel(constraintRefIds(c), labels),
    isDimension: false,
    reference: false,
    status: rowStatus(c.id, conflicting, redundant),
  }
  if (c.kind !== 'pierce') return row
  // WO-1865: a pierce names its model edge, and says so when that edge has no crossing now.
  const point = labels.get(c.point.entityId) ?? '?'
  return {
    ...row,
    operands: `${point} - "${c.source.sourceLabel}"`,
    ...(c.unresolved !== undefined
      ? { unresolved: `"${c.source.sourceLabel}" ${pierceMissPhrase(c.unresolved)}; ${point} stays where it last was.` }
      : {}),
  }
}

function dimensionRow(
  d: SketchDimension,
  labels: Map<string, string>,
  conflicting: ReadonlySet<string>,
  redundant: ReadonlySet<string>,
): BrowserRow {
  return {
    id: d.id,
    kind: d.kind,
    label: constraintKindLabel(d.kind),
    operands: `${refsLabel(dimensionRefIds(d), labels)} = ${formatDimValue(d)}`,
    isDimension: true,
    reference: !d.driving,
    status: rowStatus(d.id, conflicting, redundant),
  }
}

// ---- Grouping ------------------------------------------------------------------

// Fixed display order: constraint kinds in toolbox order, then dimension
// kinds. Only non-empty groups appear.
const CONSTRAINT_KIND_ORDER: SketchConstraintKind[] = [
  'coincident', 'concentric', 'parallel', 'perpendicular', 'collinear',
  'horizontal', 'vertical', 'tangent', 'equal',
  'midpoint', 'symmetric', 'fix', 'point_on_object',
  'continuity_g1', 'continuity_g2', 'pierce',
]

/** Build the grouped browser model. `status` is the EFFECTIVE status the
 *  caller resolved (live solve status if present, else the persisted
 *  document status) — null = never solved = no conflict/redundant info. */
export function buildBrowserModel(
  sketch: Sketch,
  status: SolveStatus | null,
): BrowserModel {
  const labels = entityLabels(sketch.entities)
  const conflicting = new Set(status?.conflicting ?? [])
  const redundant = new Set(status?.redundant ?? [])

  const groups: BrowserGroup[] = []

  for (const kind of CONSTRAINT_KIND_ORDER) {
    const rows = sketch.constraints
      .filter((c) => c.kind === kind)
      .map((c) => constraintRow(c, labels, conflicting, redundant))
    if (rows.length > 0) {
      groups.push({ kind, title: constraintKindLabel(kind), rows })
    }
  }
  for (const kind of DIMENSION_KINDS) {
    const rows = sketch.dimensions
      .filter((d) => d.kind === kind)
      .map((d) => dimensionRow(d, labels, conflicting, redundant))
    if (rows.length > 0) {
      groups.push({ kind, title: `${constraintKindLabel(kind)} dim`, rows })
    }
  }

  // Counts are DOCUMENT-WIDE (the header must stay honest even when a
  // group's render is capped).
  let conflictingCount = 0
  let redundantCount = 0
  for (const g of groups) {
    for (const r of g.rows) {
      if (r.status === 'conflicting') conflictingCount++
      else if (r.status === 'redundant') redundantCount++
    }
  }

  return {
    groups,
    constraintCount: sketch.constraints.length,
    dimensionCount: sketch.dimensions.length,
    conflictingCount,
    redundantCount,
    references: buildReferenceRows(sketch.entities, labels),
  }
}

// ---- Projected references (WO-1864) ----------------------------------------------

/** One row per projected piece: linked, unresolved (named), or not linked. */
export function buildReferenceRows(
  entities: readonly SketchEntity[],
  labels: Map<string, string> = entityLabels(entities),
): BrowserReferenceRow[] {
  const rows: BrowserReferenceRow[] = []
  for (const entity of entities) {
    if (entity.provenance !== 'projected') continue
    const entityLabel = labels.get(entity.id) ?? '?'
    const link = entity.projectionLink
    // A link on a moved/copied piece follows nothing (projectLink.ts drops it on the next pass).
    const live = link !== undefined && entity.projectionDetached !== true
    if (!live) {
      rows.push({
        entityId: entity.id, entityLabel, sourceLabel: null, status: 'not-linked',
        detail: `${entityLabel} is a static copy - it does not follow the model.`,
      })
    } else if (link.unresolved) {
      rows.push({
        entityId: entity.id, entityLabel, sourceLabel: link.sourceLabel, status: 'unresolved',
        detail: `"${link.sourceLabel}" could not be found in the model; ${entityLabel} stays where it last stood.`,
      })
    } else {
      rows.push({
        entityId: entity.id, entityLabel, sourceLabel: link.sourceLabel, status: 'linked',
        detail: `${entityLabel} follows "${link.sourceLabel}".`,
      })
    }
  }
  return rows
}

// ---- Solver-named sets (over-defined resolution flow) ---------------------------

/** Rows for the ids the solver NAMED in a set (conflicting or redundant),
 *  in the solver's order. Ids that match nothing in the document are
 *  dropped (a stale status referencing removed items must not render
 *  ghost rows). */
export function rowsForIds(sketch: Sketch, ids: readonly string[]): BrowserRow[] {
  const labels = entityLabels(sketch.entities)
  const none = new Set<string>()
  const rows: BrowserRow[] = []
  for (const id of ids) {
    const c = sketch.constraints.find((x) => x.id === id)
    if (c) { rows.push(constraintRow(c, labels, none, none)); continue }
    const d = sketch.dimensions.find((x) => x.id === id)
    if (d) rows.push(dimensionRow(d, labels, none, none))
  }
  return rows
}
