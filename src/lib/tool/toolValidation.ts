// WO-1441: the ONE shared normalize-and-validate step for a Tool or ToolHolder,
// used by every write path that can produce one (Fusion import, internal-format
// import, manual create/edit). Rule (Operator, WO-1441 authority): a negative/
// nonfinite/impossible dimension is a genuine cannot (reject the record); an
// unknown cutter type is NOT (import it, preserve what it declared, say so once).
import type { HolderSegment, Tool } from '../../types'

export const MM_PER_INCH = 25.4

/** Convert a raw geometry value to canonical mm exactly once. A fallback for a
 *  missing field must be derived from the RAW (pre-conversion) value or another
 *  already-final mm value — never both — or the fallback chain double-converts
 *  (BUG-509: an inch tool's derived shank/flute/overall length came out ~4x). */
export function toCanonicalMm(rawValue: number, unit: string): number {
  return unit === 'inches' ? rawValue * MM_PER_INCH : rawValue
}

export interface TypeResolution<T extends string> {
  type: T
  /** Set when the source declared a type string this build doesn't recognize.
   *  The record still imports under `type` (a safe fallback) — this is the only
   *  place that fallback is distinguishable from a verified match, so callers
   *  must report it once rather than treating the tool as fully characterized. */
  unknownDeclaredType?: string
}

/** BUG-510: an unrecognized external type must not be silently promoted to full
 *  fallback-type capability with no trace of what was actually declared. */
export function resolveToolType<T extends string>(
  rawType: string | undefined,
  typeMap: Record<string, T>,
  fallback: T,
): TypeResolution<T> {
  const key = rawType?.trim().toLowerCase() ?? ''
  const mapped = key ? typeMap[key] : undefined
  return mapped ? { type: mapped } : { type: fallback, unknownDeclaredType: rawType }
}

export type ValidationResult = { ok: true } | { ok: false; reason: string }

function isPositiveFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/** Physical sanity for a tool's own geometry, in canonical mm (post-normalize).
 *  Rejects a nonpositive/nonfinite dimension or a lengthBelowHolder that exceeds
 *  the tool's own overall length (BUG-511, BUG-536). A field this record doesn't
 *  specify (undefined) is skipped rather than treated as a reject — this runs
 *  against records assembled from many partial sources (a store patch touching
 *  one field, an external import missing an optional one), and only a PRESENT,
 *  physically-impossible value is a genuine cannot. */
export function validateToolGeometry(
  g: Partial<Pick<Tool, 'diameter' | 'shankDiameter' | 'fluteLength' | 'overallLength' | 'lengthBelowHolder'>>,
): ValidationResult {
  const dimensions: Array<[string, number | undefined]> = [
    ['diameter', g.diameter],
    ['shankDiameter', g.shankDiameter],
    ['fluteLength', g.fluteLength],
    ['overallLength', g.overallLength],
  ]
  for (const [field, value] of dimensions) {
    if (value === undefined) continue
    if (!isPositiveFinite(value)) {
      return { ok: false, reason: `${field} must be a positive number (got ${value})` }
    }
  }
  if (g.lengthBelowHolder !== undefined) {
    if (typeof g.lengthBelowHolder !== 'number' || !Number.isFinite(g.lengthBelowHolder)) {
      return { ok: false, reason: `lengthBelowHolder must be a finite number (got ${g.lengthBelowHolder})` }
    }
    if (g.overallLength !== undefined && g.lengthBelowHolder > g.overallLength) {
      return {
        ok: false,
        reason: `lengthBelowHolder (${g.lengthBelowHolder}) exceeds overallLength (${g.overallLength})`,
      }
    }
  }
  return { ok: true }
}

/** Physical sanity for one holder section, in canonical mm (post-normalize).
 *  A zero/negative/nonfinite dimension is rejected (BUG-519) rather than the
 *  prior silent `typeof x === 'number' ? x : 0` coercion. */
export function validateHolderSegment(s: HolderSegment): ValidationResult {
  if (!isPositiveFinite(s.height)) {
    return { ok: false, reason: `height must be a positive number (got ${s.height})` }
  }
  if (!isPositiveFinite(s.lowerDiameter)) {
    return { ok: false, reason: `lowerDiameter must be a positive number (got ${s.lowerDiameter})` }
  }
  if (!isPositiveFinite(s.upperDiameter)) {
    return { ok: false, reason: `upperDiameter must be a positive number (got ${s.upperDiameter})` }
  }
  return { ok: true }
}

/** Geometry fields an internal-format record may declare as numeric text. A
 *  string that parses to a finite number is recovered (WO-1542/rule 11); any
 *  other non-number value is still a shape defect. */
const GEOMETRY_FIELDS = [
  'diameter',
  'shankDiameter',
  'fluteLength',
  'overallLength',
  'shoulderLength',
  'lengthBelowHolder',
  'cornerRadius',
] as const

export interface RecoveredToolRecord {
  /** The raw record with geometry strings coerced to numbers and, when the
   *  source had no usable name, a generated one (type + diameter, the same
   *  shape the Fusion importer uses for a nameless tool). */
  tool: Record<string, unknown>
  /** True when `tool.name` was generated here rather than declared. */
  nameGenerated: boolean
}

export type RecordShapeResult =
  | { ok: true; record: RecoveredToolRecord }
  | { ok: false; reason: string }

/** Shape gate + recovery for a raw (untyped) imported record, ahead of physical
 *  validation. WO-1542 (rule 11): a missing/empty name and a geometry field
 *  written as numeric text are things the software CAN do, so they are
 *  recovered rather than refused — the record imports with a generated name
 *  and the parsed number. A genuinely unrecoverable value (a non-numeric
 *  string, null, a boolean) still skips the record with its own reason, and
 *  BUG-518's numeric-text shape defect is no longer a refusal.
 *
 *  `diameter` is the ONE field that must be PRESENT: a tool with no diameter is
 *  a genuine cannot (rule 11), so an absent or nonfinite diameter still skips
 *  the record with main's reason rather than importing `diameter: undefined`. */
export function validateToolRecordShape(raw: unknown): RecordShapeResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: 'record is not an object' }
  }
  const t = raw as Record<string, unknown>
  const tool: Record<string, unknown> = { ...t }
  for (const field of GEOMETRY_FIELDS) {
    const value = tool[field]
    if (value === undefined) continue
    if (typeof value === 'string') {
      const trimmed = value.trim()
      const parsed = trimmed === '' ? NaN : Number(trimmed)
      if (!Number.isFinite(parsed)) {
        return { ok: false, reason: `${field} must be a number (got ${JSON.stringify(value)})` }
      }
      tool[field] = parsed
      continue
    }
    if (typeof value !== 'number') {
      return { ok: false, reason: `${field} must be a number (got ${JSON.stringify(value)})` }
    }
  }
  // `diameter` must be PRESENT and finite: every consumer (tool-radius math,
  // diagram scaling, feed defaults) needs one, and a tool without it is a
  // genuine cannot. The other six fields stay recover-if-present above.
  const diameter = tool.diameter
  if (typeof diameter !== 'number' || !Number.isFinite(diameter)) {
    return { ok: false, reason: `diameter must be a number (got ${JSON.stringify(diameter)})` }
  }
  const nameGenerated = typeof t.name !== 'string' || t.name.trim().length === 0
  if (nameGenerated) {
    const declaredType = typeof t.type === 'string' && t.type.trim() ? t.type : 'flat_end_mill'
    const label = declaredType.replace(/_/g, ' ')
    tool.name = `${label} ${diameter.toFixed(1)}mm`
  }
  return { ok: true, record: { tool, nameGenerated } }
}

/** One entry in a batch import's diagnostics: which record, and why it was
 *  rejected or flagged. `label` should identify the record (name or index) so
 *  the console summary reads as a per-record reason, never a bare count. */
export interface RecordDiagnostic {
  label: string
  reason: string
}
