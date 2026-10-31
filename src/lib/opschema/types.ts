// WO-3275 (UI M2 Wave 0): the operation-parameter schema contract (M2-PLAN standard 9).
// Each operation type declares its parameters ONCE: key, type, unit, range, default, label and
// help keys, group, and when it shows. The operation card, help, defaults and validation all
// render from that declaration, so adding a parameter is one entry in one file. Tool profile
// steps (W1-J) use the 'list' type.
// Wave 1 (W1-F) replaces the stub in ./index.ts and pilots it on Pocket; only the Wave 0 owner
// changes this file.
import type { ReactElement, ReactNode } from 'react'
import type { MessageKey } from '../../notices/types'
import type { Quantity } from '../units/types'

export const PARAM_TYPES = ['number', 'integer', 'boolean', 'choice', 'text', 'tool', 'geometry', 'list'] as const
export type ParamType = (typeof PARAM_TYPES)[number]

/** Section order inside a card (spec 6.4). An operation: Tool, Geometry, Heights, Passes,
 *  Linking, Feeds, then its type-specific groups ('custom:<name>', in declaration order). A
 *  feature: Input, Extent, Result, then options. Custom groups sort after every named group but
 *  'options', which is always last. */
export const PARAM_GROUPS = ['tool', 'geometry', 'heights', 'passes', 'linking', 'feeds', 'input', 'extent', 'result', 'options'] as const
export type ParamGroup = (typeof PARAM_GROUPS)[number] | `custom:${string}`

/** A stored parameter value. Lengths are mm, angles degrees, feeds mm/min (units service). */
export type ParamValue = number | boolean | string | null | readonly ParamRecord[]
export type ParamRecord = Readonly<Record<string, ParamValue>>
export type ParamValues = ParamRecord

export interface ParamChoice {
  readonly value: string
  readonly labelKey: MessageKey
}

/** Parameter types the card cannot draw from the declaration alone: the screen supplies the
 *  picker through `renderSlot` (WO-3289, requested by W1-F). */
export const SLOT_PARAM_TYPES = ['tool', 'geometry'] as const

export interface ParamRange {
  readonly min?: number
  readonly max?: number
  /** true when min itself is not allowed (a diameter > 0). */
  readonly minExclusive?: boolean
}

export interface ParamDecl {
  readonly key: string
  readonly type: ParamType
  /** For number and integer: what the number measures (decides unit and format). */
  readonly quantity?: Quantity
  /** Arrow-key step in stored units, and decimal places shown (else the units service default). */
  readonly step?: number
  readonly precision?: number
  readonly range?: ParamRange
  readonly default: ParamValue
  readonly labelKey: MessageKey
  readonly helpKey?: MessageKey
  readonly group: ParamGroup
  /** For 'choice'. */
  readonly choices?: readonly ParamChoice[]
  /** For 'list': the fields of one item (tool profile steps, holder segments). */
  readonly item?: readonly ParamDecl[]
  /** When the parameter shows; absent = always. A hidden parameter keeps its value. */
  readonly visible?: (values: ParamValues) => boolean
  /** Starts folded with its group (spec 6.4: rarely changed sections start folded). */
  readonly advanced?: boolean
}

export interface OpSchema {
  /** The operation type id as the store names it ('pocket'). */
  readonly opType: string
  readonly params: readonly ParamDecl[]
}

/** One problem with a value, for the field to show. Only what the software cannot run is an
 *  issue (LIENCAM.md rule 11); the reason is a catalogue key. */
export interface ParamIssue {
  readonly key: string
  readonly reason: MessageKey
  readonly params?: Readonly<Record<string, string | number>>
}

/** The schema functions every consumer shares. */
export interface OpSchemaApi {
  /** Every parameter's default, keyed by parameter key. */
  defaultsOf(schema: OpSchema): ParamValues
  /** The parameters that show for these values, in declaration order. */
  visibleParams(schema: OpSchema, values: ParamValues): readonly ParamDecl[]
  /** Parameters grouped for the card, groups in spec 6.4 order then custom groups. */
  groupsOf(schema: OpSchema, values: ParamValues): readonly { readonly group: ParamGroup; readonly params: readonly ParamDecl[] }[]
  /** Checks for the visible parameters. The stub checks only that numbers are numbers; what a
   *  range means (clamp in the field, or a reason the operation cannot run) is W1-F's to decide
   *  per LIENCAM.md rule 11, never a refusal of something the software can do. */
  validate(schema: OpSchema, values: ParamValues): readonly ParamIssue[]
}

/** The renderer's props: the operation card body is drawn from these and nothing else. */
export interface OpSchemaRendererProps {
  readonly schema: OpSchema
  readonly values: ParamValues
  onChange(key: string, value: ParamValue): void
  /** Disables every field while the operation cannot be edited (e.g. computing). */
  readonly readOnly?: boolean
  /** The operation's tool, for limits that depend on it (stepover as a share of the diameter);
   *  absent = no tool-relative limit applies. */
  readonly context?: OpSchemaContext
  /** Draws the picker of a parameter whose type is in SLOT_PARAM_TYPES; the card leaves an empty
   *  slot when absent. */
  renderSlot?(decl: ParamDecl): ReactNode
}
export interface OpSchemaContext {
  /** Tool diameter in mm. */
  readonly toolDiameter?: number
}
/** The renderer signature (W1-F implements it as a React component). */
export type OpSchemaRenderer = (props: OpSchemaRendererProps) => ReactElement | null
