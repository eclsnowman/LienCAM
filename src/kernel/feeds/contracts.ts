// WO-3033 (alpha.3 A3-15): the kernel feed/speed service's data contracts.
//
// A feed rule is keyed by pass role x material x tool type x diameter interval x
// coating x rigidity class (draft WO-A3-15, alpha3-17 A.4.4). Every rule names its
// source and units; a ruleset carries an id and a version so a later change of
// numbers is a new version, never an edit in place (MD-74 / MD-76, data layer only).

import type { FeedsAndSpeeds, ToolCoating, ToolType } from '../../types'
import type { LinkRole, RoleRate } from '../linking/roles'

/** Machine rigidity classes a rule may name. No machine profile states one today, so
 *  an absent class matches only rules that leave rigidity open (never invented). */
export type RigidityClass = 'rigid' | 'medium' | 'light'

/** `'*'` leaves a key dimension open. */
export type Any = '*'

export interface FeedRuleKey {
  readonly role: LinkRole | Any
  /** A cutting-data entry key (today's tool presets are keyed by material name). */
  readonly material: string | Any
  readonly toolType: ToolType | Any
  /** Closed interval, mm. */
  readonly diameterMm: readonly [number, number] | Any
  readonly coating: ToolCoating | Any
  readonly rigidity: RigidityClass | Any
}

export interface RuleSource {
  /** 'liencam-current': today's code, cited file:line (the parity ruleset's only kind).
   *  'maker-publication': a cutting-tool maker's published data, cited by https URL. */
  readonly kind: 'liencam-current' | 'maker-publication'
  readonly cite: string
}

/** One role feed row: the resolved rate a matching move is fed at. */
export interface FeedRule {
  readonly id: string
  readonly key: FeedRuleKey
  /** null: the role is a rapid (G0), fed at no rate. */
  readonly rate: RoleRate | null
  readonly units: 'mm/min'
  readonly source: readonly RuleSource[]
  /** 'current-behaviour' rows reproduce today; nothing else may set an emitted number
   *  until it is confirmed and carded (A-30). */
  readonly confidence: 'current-behaviour' | 'EXT-starting-window' | 'published-tested' | 'locally-confirmed'
}

/** How one resolved rate is obtained when no override is enabled: the cutting-data
 *  entry field, then the stage below it. */
export type RateFallback =
  /** A logged constant for genuinely degraded inputs (a tool with no entry value). */
  | { readonly kind: 'safety'; readonly value: number }
  /** Another resolved rate times a factor, rounded to the nearest whole mm/min. */
  | { readonly kind: 'derived'; readonly from: RoleRate; readonly factor: number; readonly round: boolean }
  /** The machine rapid when supplied, else another resolved rate. */
  | { readonly kind: 'machine-rapid-then'; readonly from: RoleRate }

export interface RateStage {
  readonly rate: RoleRate
  /** FeedrateOverride field read when the operation override is enabled. */
  readonly overrideField: 'feedRate' | 'plungeRate' | 'rampFeedrate' | 'leadInFeedrate' | 'leadOutFeedrate' | 'fastTraverseFeedrate' | 'finishFeedrate'
  /** Rate used when the enabled override leaves `overrideField` absent (finish only). */
  readonly overrideAbsent?: RoleRate
  /** Cutting-data entry field. */
  readonly entryField: keyof FeedsAndSpeeds
  readonly fallback: RateFallback
  /** The machine rapid rate, when supplied, caps the result. */
  readonly machineRapidCeiling: boolean
  readonly units: 'mm/min'
  readonly source: readonly RuleSource[]
}

export interface FeedRuleset {
  readonly id: string
  readonly version: string
  /** Order matters: a stage may read only rates resolved by an earlier stage. */
  readonly stages: readonly RateStage[]
  readonly rules: readonly FeedRule[]
}

/** The cutting-data entry chosen once per operation; feed and spindle both read it. */
export interface CuttingDataSelection {
  /** The entry key chosen, or null when the tool has no entries. */
  readonly key: string | null
  readonly entry: FeedsAndSpeeds | undefined
  readonly how: 'material' | 'default' | 'first' | 'none'
  /** The material key asked for, if any. */
  readonly materialAsked?: string
}

export type RateProvenance =
  | { readonly from: 'operation-override' }
  | { readonly from: 'cutting-data'; readonly key: string }
  | { readonly from: 'derived'; readonly stage: RoleRate }
  | { readonly from: 'machine-rapid' }
  | { readonly from: 'safety-fallback'; readonly value: number }

/** A role's feed row as resolved for one request. */
export interface RoleFeed {
  readonly role: LinkRole
  readonly rate: RoleRate | null
  /** Rule id + ruleset version, or today's text when no rule row matched (the stick's rule-provenance measurement). */
  readonly provenance: { readonly ruleId: string; readonly version: string } | 'tool library, no rule'
}
