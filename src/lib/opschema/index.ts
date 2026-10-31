// WO-3283 (UI M2 W1-F): the parameter-schema service (M2-PLAN standard 9). Each operation type
// declares its parameters once (./schemas); the New Operation card and the Properties panel both
// draw from that one declaration through these functions, and an edit made through the schema
// stores exactly what the old editors store, so Wave 2 can switch editors without a data change.
//
// Parameter keys are paths into the stored operation: 'toolId' is a field of the operation itself,
// 'params.direction' a field of op.params, 'passes.stepdown' of op.passes, 'linking.entryType' of
// op.linking. The renderer lives in src/components/opschema (src/lib may not import react).
import type { MessageKey, MessageParams } from '../../notices/types'
import { resolveMessage } from '../../notices'
import { units } from '../units'
import type { OpSchema, OpSchemaApi, ParamChoice, ParamDecl, ParamGroup, ParamIssue, ParamRange, ParamRecord, ParamValue, ParamValues } from './types'
import { PARAM_GROUPS } from './types'

export * from './types'

const AREA = 'ui2-opschema.wo3283'
const NOT_A_NUMBER: MessageKey = `${AREA}:issue.notANumber`
const NOT_WHOLE: MessageKey = `${AREA}:issue.notWhole`
const BELOW_MIN: MessageKey = `${AREA}:issue.belowMin`
const NOT_ABOVE_MIN: MessageKey = `${AREA}:issue.notAboveMin`
const ABOVE_MAX: MessageKey = `${AREA}:issue.aboveMax`

/** An operation as the store holds it: top-level fields and the params/passes/linking records. */
export type StoredOperation = Readonly<Record<string, unknown>>
/** What an edit changes, in the shape the store's updateOperation takes: whole replacement
 *  records for each container it touches, and top-level fields. */
export type OperationPatch = Readonly<Record<string, unknown>>

export interface EditContext {
  /** The operation is being created (New Operation), not edited: some linked edits apply only
   *  then, as in the old dialog. */
  readonly creating?: boolean
}

/** What the screen knows that a declaration cannot: the operation's tool. */
export interface OpContext {
  readonly toolDiameter?: number
}

/** The behaviour an operation type adds to its declaration. Every part is optional. */
export interface OpSchemaRules {
  /** What the old editors show for a stored field that is absent (an operation saved before the
   *  field existed). Unlisted absent fields show their declared default. */
  readonly absent?: Readonly<Record<string, ParamValue>>
  /** Where an older operation stored a field that is absent from its own place, keyed by
   *  parameter key ('passes.floorStockToLeave' -> 'params.floorStockToLeave'). It is read before
   *  `absent`, as the old editors and the toolpath read it. */
  readonly storedElsewhere?: Readonly<Record<string, string>>
  /** The whole record an edit starts from when the operation has no such record yet. */
  readonly containerFallback?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  /** Further stored fields one edit also changes (and the edited field's own stored form), as
   *  the old editors do, keyed by path ('heights.bottomManual' reaches records the schema does not
   *  declare). Gets the edited value, the values before the edit and the stored operation. */
  linked?(key: string, value: ParamValue, before: ParamValues, op: StoredOperation, context: EditContext): Readonly<Record<string, unknown>>
  /** Problems that involve more than one field. Only what the software cannot run (rule 11). */
  check?(values: ParamValues): readonly ParamIssue[]
  /** The choices a choice parameter offers for these values (the old editors' filtered lists). */
  choices?(key: string, values: ParamValues): readonly string[] | undefined
  /** A stored value the old editors read as their fallback instead (a negative floor hop reads as
   *  the default hop): true keeps the stored value. */
  storedReads?(key: string, stored: unknown): boolean
  /** Values a new operation takes from its tool, as the old dialog seeds them. */
  seed?(context: OpContext): ParamValues
  /** A range that depends on the tool, replacing the declared one when the tool is known. */
  range?(key: string, context: OpContext): ParamRange | undefined
}

const RULES = new WeakMap<OpSchema, OpSchemaRules>()

/** Declares an operation type's schema with its rules; returns the schema itself. */
export function defineOpSchema(schema: OpSchema, rules: OpSchemaRules = {}): OpSchema {
  // frozen, so a screen cannot change a declaration it shares; a copy has no rules, so use the
  // declared object itself (schemaFor)
  const frozen = Object.freeze({ ...schema, params: Object.freeze([...schema.params]) })
  RULES.set(frozen, rules)
  return frozen
}

const rulesOf = (schema: OpSchema): OpSchemaRules => RULES.get(schema) ?? {}

// custom groups sit between the named groups and 'options' (types.ts PARAM_GROUPS)
const groupRank = (g: ParamGroup) => {
  if (g === 'options') return PARAM_GROUPS.length + 1
  const at = (PARAM_GROUPS as readonly string[]).indexOf(g)
  return at >= 0 ? at : PARAM_GROUPS.length
}

const isNumeric = (p: ParamDecl) => p.type === 'number' || p.type === 'integer'

/** The limit as the operator reads it, in their unit. */
function limitText(p: ParamDecl, limit: number): string {
  return units.format(p.quantity ?? 'none', limit, { trim: true })
}

function fieldIssue(p: ParamDecl, key: string, reason: MessageKey, extra?: MessageParams): ParamIssue {
  return { key, reason, params: { field: resolveMessage(p.labelKey), ...extra } }
}

/** One number checked against its declaration: a number, whole for an integer, inside its range. */
function checkNumber(p: ParamDecl, key: string, v: ParamValue, range: ParamRange | undefined = p.range): ParamIssue | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' || !Number.isFinite(v)) return fieldIssue(p, key, NOT_A_NUMBER)
  if (p.type === 'integer' && !Number.isInteger(v)) return fieldIssue(p, key, NOT_WHOLE)
  const r = range
  if (r?.min !== undefined && (r.minExclusive ? v <= r.min : v < r.min)) {
    return fieldIssue(p, key, r.minExclusive ? NOT_ABOVE_MIN : BELOW_MIN, { limit: limitText(p, r.min) })
  }
  if (r?.max !== undefined && v > r.max) return fieldIssue(p, key, ABOVE_MAX, { limit: limitText(p, r.max) })
  return null
}

function checkParams(params: readonly ParamDecl[], values: ParamValues, prefix: string, rangeOf: (p: ParamDecl) => ParamRange | undefined = p => p.range): ParamIssue[] {
  const issues: ParamIssue[] = []
  for (const p of params) {
    if (p.visible !== undefined && !p.visible(values)) continue
    const v = values[p.key]
    if (isNumeric(p)) {
      const issue = checkNumber(p, prefix + p.key, v, rangeOf(p))
      if (issue) issues.push(issue)
    } else if (p.type === 'list' && p.item && Array.isArray(v)) {
      (v as readonly ParamRecord[]).forEach((item, i) => issues.push(...checkParams(p.item!, item, `${prefix}${p.key}.${i}.`)))
    }
  }
  return issues
}

export const opSchema: OpSchemaApi = {
  defaultsOf(schema: OpSchema) {
    // a copy, so a list default is never shared between operations
    return Object.fromEntries(schema.params.map(p => [p.key, structuredClone(p.default)]))
  },
  visibleParams(schema, values) {
    return schema.params.filter(p => p.visible === undefined || p.visible(values))
  },
  groupsOf(schema, values) {
    const groups = new Map<ParamGroup, ParamDecl[]>()
    for (const p of opSchema.visibleParams(schema, values)) {
      const list = groups.get(p.group) ?? []
      list.push(p)
      groups.set(p.group, list)
    }
    return [...groups.entries()]
      .map(([group, params], order) => ({ group, params, order }))
      .sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.order - b.order)
      .map(({ group, params }) => ({ group, params }))
  },
  // Range policy (LIENCAM.md rule 11): a declared range is the limit the old editors hold a field
  // to, so a value outside it is one the operation is not built for; the issue names the field and
  // the limit and refuses nothing else. Hidden parameters keep their value and are not checked.
  validate(schema, values: ParamValues) {
    return [...checkParams(schema.params, values, ''), ...(rulesOf(schema).check?.(values) ?? [])]
  },
}

/** The range a field holds to: the declared one, or the tool's when the tool is known. */
export function rangeFor(schema: OpSchema, decl: ParamDecl, context: OpContext = {}): ParamRange | undefined {
  return rulesOf(schema).range?.(decl.key, context) ?? decl.range
}

/** validate, with the ranges that depend on the tool. */
export function validateFor(schema: OpSchema, values: ParamValues, context: OpContext = {}): readonly ParamIssue[] {
  return [...checkParams(schema.params, values, '', p => rangeFor(schema, p, context)), ...(rulesOf(schema).check?.(values) ?? [])]
}

/** A new operation's values: the defaults, plus what the dialog seeds from the tool. */
export function defaultsFor(schema: OpSchema, context: OpContext = {}): ParamValues {
  return { ...opSchema.defaultsOf(schema), ...rulesOf(schema).seed?.(context) }
}

/** The choices a choice field offers for these values. The current value always stays in the
 *  list, so a stored value the rules no longer offer still shows (its issue says why). */
export function choicesOf(schema: OpSchema, decl: ParamDecl, values: ParamValues): readonly ParamChoice[] {
  const all = decl.choices ?? []
  const allowed = rulesOf(schema).choices?.(decl.key, values)
  if (!allowed) return all
  return all.filter(c => allowed.includes(c.value) || c.value === values[decl.key])
}

/** The issue as the operator reads it: the field's name and its limit in their language. */
export function issueMessage(issue: ParamIssue): string {
  return resolveMessage(issue.reason, issue.params)
}

const splitKey = (key: string): [string | null, string] => {
  const dot = key.indexOf('.')
  return dot < 0 ? [null, key] : [key.slice(0, dot), key.slice(dot + 1)]
}

const recordOf = (v: unknown): Readonly<Record<string, unknown>> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Readonly<Record<string, unknown>> : undefined

/** The values a stored operation shows, keyed by parameter key. A stored field that is absent
 *  shows what the old editors show for it. */
export function readValues(schema: OpSchema, op: StoredOperation): ParamValues {
  const { absent = {}, containerFallback = {}, storedElsewhere = {}, storedReads } = rulesOf(schema)
  const storedAt = (key: string) => {
    const [container, field] = splitKey(key)
    const record = container === null ? op : recordOf(op[container]) ?? containerFallback[container]
    return record?.[field]
  }
  const out: Record<string, ParamValue> = {}
  for (const p of schema.params) {
    const own = storedAt(p.key)
    const elsewhere = storedElsewhere[p.key]
    const stored = own !== undefined || elsewhere === undefined ? own : storedAt(elsewhere) ?? undefined
    out[p.key] = stored !== undefined && (storedReads?.(p.key, stored) ?? true)
      ? structuredClone(stored as ParamValue)
      : structuredClone(p.key in absent ? absent[p.key] : p.default)
  }
  return out
}

/** The change one edit makes to a stored operation, in the shape the store's updateOperation
 *  takes: each record it touches is the whole record with the edit merged in, as the old
 *  editors write it. An integer field stores a whole number. */
export function applyEdit(schema: OpSchema, op: StoredOperation, key: string, value: ParamValue, context: EditContext = {}): OperationPatch {
  const rules = rulesOf(schema)
  const decl = schema.params.find(p => p.key === key)
  const stored = decl?.type === 'integer' && typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : value
  const writes: Record<string, unknown> = { [key]: stored }
  Object.assign(writes, rules.linked?.(key, stored, readValues(schema, op), op, context))
  const patch: Record<string, unknown> = {}
  for (const [path, v] of Object.entries(writes)) {
    const [container, field] = splitKey(path)
    if (container === null) { patch[field] = v; continue }
    const base = (patch[container] as Record<string, unknown> | undefined)
      ?? { ...(recordOf(op[container]) ?? rules.containerFallback?.[container] ?? {}) }
    patch[container] = { ...base, [field]: v }
  }
  return patch
}
