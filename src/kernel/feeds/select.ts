// WO-3033: one cutting-data entry selection per operation, and the role rule lookup.

import type { Tool, ToolType } from '../../types'
import { feedRowFor, type LinkRole } from '../linking/roles'
import type { CuttingDataSelection, FeedRule, FeedRuleset, RigidityClass, RoleFeed } from './contracts'
import type { FeedPolicy } from './policy'

/** The entry feed and spindle read. Parity (MD-75 off) is today's spindle choice
 *  (src/lib/post/resolve.ts pickFeeds): 'default', else the first key. MD-75 puts the
 *  operation's material key in front of both. */
export function selectCuttingData(
  tool: Pick<Tool, 'feedsAndSpeeds'>,
  material: string | undefined,
  policy: Pick<FeedPolicy, 'md75_material_entry'>,
): CuttingDataSelection {
  const fs = tool.feedsAndSpeeds
  const asked = material === undefined ? {} : { materialAsked: material }
  if (policy.md75_material_entry && material !== undefined && fs && Object.prototype.hasOwnProperty.call(fs, material) && fs[material]) {
    return { key: material, entry: fs[material], how: 'material', ...asked }
  }
  if (fs?.default) return { key: 'default', entry: fs.default, how: 'default', ...asked }
  const first = fs ? Object.keys(fs)[0] : undefined
  return first ? { key: first, entry: fs[first], how: 'first', ...asked } : { key: null, entry: undefined, how: 'none', ...asked }
}

/** What a rule key is matched against. */
export interface RuleQuery {
  readonly role: LinkRole
  readonly material?: string
  readonly toolType?: ToolType
  readonly diameterMm?: number
  readonly coating?: Tool['coating']
  readonly rigidity?: RigidityClass
}

function matches(rule: FeedRule, q: RuleQuery): boolean {
  const k = rule.key
  if (k.role !== '*' && k.role !== q.role) return false
  if (k.material !== '*' && k.material !== q.material) return false
  if (k.toolType !== '*' && k.toolType !== q.toolType) return false
  if (k.coating !== '*' && k.coating !== q.coating) return false
  if (k.rigidity !== '*' && k.rigidity !== q.rigidity) return false
  if (k.diameterMm !== '*') {
    const d = q.diameterMm
    if (d === undefined || !(d >= k.diameterMm[0] && d <= k.diameterMm[1])) return false
  }
  return true
}
const specificity = (rule: FeedRule) =>
  Object.values(rule.key).filter(value => value !== '*').length

/** The rule for a query: the most specific matching row, the earlier row on a tie. */
export function matchRule(ruleset: FeedRuleset, q: RuleQuery): FeedRule | undefined {
  let best: FeedRule | undefined
  for (const rule of ruleset.rules) {
    if (matches(rule, q) && (best === undefined || specificity(rule) > specificity(best))) best = rule
  }
  return best
}

/** A role's feed row. No matching rule proceeds exactly as today: the WO-3026 role
 *  table's rate, provenance "tool library, no rule" (the stick's rule-provenance measurement). Unknown roles throw,
 *  as feedRowFor does - a kernel caller bug, never an operator refusal. */
export function roleFeed(ruleset: FeedRuleset, q: RuleQuery): RoleFeed {
  const today = feedRowFor(q.role)
  const rule = matchRule(ruleset, q)
  return rule
    ? { role: today.role, rate: rule.rate, provenance: { ruleId: rule.id, version: ruleset.version } }
    : { role: today.role, rate: today.rate, provenance: 'tool library, no rule' }
}
