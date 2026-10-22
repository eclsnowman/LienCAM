// WO-3033 (alpha.3 A3-15): the versioned rule data the feed/speed service reads.
//
// PARITY_RULESET reproduces today's two-tier resolver (src/lib/cam/feedrates.ts) and
// today's role feed rows (WO-3026, src/kernel/linking/roles.ts) as data. Its only
// source kind is 'liencam-current': no maker window or community recipe supplies a
// starting number here (A-30). A ruleset whose numbers differ is a new version.

import { MOVE_ROLES, type LinkRole, type RoleRate } from '../linking/roles'
import type { FeedRule, FeedRuleKey, FeedRuleset, RateStage, RuleSource } from './contracts'

const FEEDRATES = 'src/lib/cam/feedrates.ts'
const cite = (line: string): RuleSource => ({ kind: 'liencam-current', cite: `${FEEDRATES}:${line}` })

const stage = (s: Omit<RateStage, 'units'>): RateStage => Object.freeze({ ...s, units: 'mm/min' as const })

/** Today's two-tier chain, one stage per resolved rate, in resolution order. */
const PARITY_STAGES: readonly RateStage[] = Object.freeze([
  stage({ rate: 'feedRate', overrideField: 'feedRate', entryField: 'feedRate',
    fallback: { kind: 'safety', value: 300 }, machineRapidCeiling: false, source: [cite('54'), cite('85-96')] }),
  stage({ rate: 'plungeRate', overrideField: 'plungeRate', entryField: 'plungeRate',
    fallback: { kind: 'safety', value: 100 }, machineRapidCeiling: false, source: [cite('55'), cite('98-108')] }),
  stage({ rate: 'rampRate', overrideField: 'rampFeedrate', entryField: 'rampFeedrate',
    fallback: { kind: 'derived', from: 'plungeRate', factor: 1.5, round: true }, machineRapidCeiling: false, source: [cite('110')] }),
  stage({ rate: 'leadInRate', overrideField: 'leadInFeedrate', entryField: 'leadInFeedrate',
    fallback: { kind: 'derived', from: 'feedRate', factor: 1, round: false }, machineRapidCeiling: false, source: [cite('111')] }),
  stage({ rate: 'leadOutRate', overrideField: 'leadOutFeedrate', entryField: 'leadOutFeedrate',
    fallback: { kind: 'derived', from: 'feedRate', factor: 1, round: false }, machineRapidCeiling: false, source: [cite('112')] }),
  stage({ rate: 'fastTraverseRate', overrideField: 'fastTraverseFeedrate', entryField: 'fastTraverseFeedrate',
    fallback: { kind: 'machine-rapid-then', from: 'feedRate' }, machineRapidCeiling: true, source: [cite('118-121')] }),
  stage({ rate: 'finishRate', overrideField: 'finishFeedrate', overrideAbsent: 'feedRate', entryField: 'finishFeedrate',
    fallback: { kind: 'derived', from: 'feedRate', factor: 1, round: false }, machineRapidCeiling: false, source: [cite('126-128')] }),
])

const OPEN: Omit<FeedRuleKey, 'role'> = Object.freeze({
  material: '*', toolType: '*', diameterMm: '*', coating: '*', rigidity: '*',
})

/** Today's rate per role (src/kernel/linking/roles.ts ROLE_FEED_TABLE, measured by WO-3026). */
const PARITY_ROLE_RATES: Readonly<Record<LinkRole, RoleRate | null>> = Object.freeze({
  rapid: null,
  cut: 'feedRate',
  helix: 'rampRate',
  ramp: 'rampRate',
  plunge: 'plungeRate',
  stepover: 'feedRate',
  fast_traverse: 'fastTraverseRate',
  lead_in: 'leadInRate',
  lead_out: 'leadOutRate',
  loop_back: 'feedRate',
  wall_follow: 'feedRate',
  finish: 'finishRate',
})

const PARITY_RULES: readonly FeedRule[] = Object.freeze(MOVE_ROLES.map(role => Object.freeze({
  id: `parity.role.${role}`,
  key: Object.freeze({ role, ...OPEN }),
  rate: PARITY_ROLE_RATES[role],
  units: 'mm/min' as const,
  source: Object.freeze([{ kind: 'liencam-current' as const, cite: 'src/kernel/linking/roles.ts ROLE_FEED_TABLE (WO-3026)' }]),
  confidence: 'current-behaviour' as const,
})))

export const PARITY_RULESET: FeedRuleset = Object.freeze({
  id: 'liencam.feeds.parity',
  version: '1.0.0',
  stages: PARITY_STAGES,
  rules: PARITY_RULES,
})

/** Schema check (REQ-DC-18): every stage and rule has a source and units, ids are
 *  unique, intervals are ordered, stages read only earlier rates, maker publications
 *  cite an https URL. Throws on the first defect; returns the ruleset. */
export function validateRuleset(ruleset: FeedRuleset): FeedRuleset {
  if (!ruleset.id || !/^\d+\.\d+\.\d+$/.test(ruleset.version)) throw new Error('feeds ruleset: id and semver version required')
  const sourced = (what: string, source: readonly RuleSource[]) => {
    if (!source.length) throw new Error(`feeds ruleset: ${what} has no source`)
    for (const s of source) {
      if (!s.cite) throw new Error(`feeds ruleset: ${what} has an empty source`)
      if (s.kind === 'maker-publication' && !/^https:\/\//.test(s.cite)) throw new Error(`feeds ruleset: ${what} maker source needs an https URL`)
    }
  }
  const resolved = new Set<RoleRate>()
  for (const s of ruleset.stages) {
    if (s.units !== 'mm/min') throw new Error(`feeds ruleset: stage ${s.rate} has no units`)
    sourced(`stage ${s.rate}`, s.source)
    if (resolved.has(s.rate)) throw new Error(`feeds ruleset: stage ${s.rate} repeated`)
    const reads = [s.overrideAbsent, s.fallback.kind === 'safety' ? undefined : s.fallback.from].filter(r => r !== undefined)
    for (const r of reads) if (!resolved.has(r!)) throw new Error(`feeds ruleset: stage ${s.rate} reads ${r} before it is resolved`)
    if (s.fallback.kind !== 'machine-rapid-then' && !(Number.isFinite(s.fallback.kind === 'safety' ? s.fallback.value : s.fallback.factor))) {
      throw new Error(`feeds ruleset: stage ${s.rate} fallback is not a number`)
    }
    resolved.add(s.rate)
  }
  const ids = new Set<string>()
  for (const r of ruleset.rules) {
    if (!r.id || ids.has(r.id)) throw new Error(`feeds ruleset: rule id '${r.id}' missing or repeated`)
    ids.add(r.id)
    if (r.units !== 'mm/min') throw new Error(`feeds ruleset: rule ${r.id} has no units`)
    sourced(`rule ${r.id}`, r.source)
    const d = r.key.diameterMm
    if (d !== '*' && !(d.length === 2 && d.every(Number.isFinite) && d[0] >= 0 && d[1] >= d[0])) throw new Error(`feeds ruleset: rule ${r.id} diameter interval invalid`)
    if (r.rate !== null && !resolved.has(r.rate)) throw new Error(`feeds ruleset: rule ${r.id} names rate ${r.rate} no stage resolves`)
  }
  return ruleset
}
validateRuleset(PARITY_RULESET)
