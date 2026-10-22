// WO-3033 (alpha.3 A3-15): the kernel feed/speed service at parity.
//
// One cutting-data selection serves feed and spindle; today's two-tier resolver
// (operation override when enabled, else the tool's entry, else the stage fallback)
// is the output stage, read from the ruleset's stages. With PARITY_RULESET and
// PARITY_FEED_POLICY every number equals today's:
//   rates   = src/lib/cam/feedrates.ts resolveFeedrates(tool, override, machineRapidRate)
//   spindle = src/lib/post/resolve.ts requestedSpindleRpm / resolveSpindle (rpm)
//   move F  = src/lib/cam/feedrates.ts applyResolvedMoveFeed (via the WO-3026 role rows)
// Called by no app path yet. Where today warns on the console (a missing feed) or
// clamps (rpm outside the machine), the service proceeds the same and says so in
// `reports`, one line each - it adds no refusal (rule 11).

import type { FeedrateOverride, FeedsAndSpeeds, MachineConfig, Tool } from '../../types'
import { MOVE_ROLES, ROLE_FEED_TABLE, type LinkRole, type RoleRate } from '../linking/roles'
import type { CuttingDataSelection, FeedRuleset, RateProvenance, RigidityClass, RoleFeed } from './contracts'
import { PARITY_FEED_POLICY, type FeedPolicy } from './policy'
import { PARITY_RULESET } from './ruleData'
import { roleFeed, selectCuttingData } from './select'
import { chipThinningFactor } from './thinning'

export type FeedRates = Record<RoleRate, number>

export interface FeedSpeedRequest {
  tool: Tool
  override?: FeedrateOverride
  /** Today's third resolveFeedrates argument: default and ceiling of the fast traverse. */
  machineRapidRate?: number
  /** Spindle bounds as the post reads them; an unstated bound clamps nothing. */
  machine?: Pick<MachineConfig, 'minSpindleRpm' | 'maxSpindleRpm'>
  /** The operation's material key (MD-75 and rule keying only). */
  material?: string
  rigidity?: RigidityClass
  /** Radial engagement as a fraction of D (MD-77 only). */
  aeOverD?: number
}

export interface SpindleResult {
  /** What the operation asked for before machine bounds (today's requestedSpindleRpm). */
  requestedRpm: number
  /** Posted rpm after the bounds the machine states (today's resolveSpindle rpm). */
  rpm: number
  provenance: 'operation-override' | { from: 'cutting-data'; key: string } | 'no cutting data'
}

export interface FeedSpeedResult {
  ruleset: { id: string; version: string }
  policy: Readonly<FeedPolicy>
  selection: CuttingDataSelection
  /** The entry the feed stage read: the selection, or none (RC-019 at parity). */
  feedEntryKey: string | null
  rates: Readonly<FeedRates>
  rateProvenance: Readonly<Record<RoleRate, RateProvenance>>
  spindle: SpindleResult
  roles: Readonly<Record<LinkRole, RoleFeed>>
  /** One line per fallback used or bound applied; never a refusal. */
  reports: readonly string[]
}

export interface FeedSpeedService {
  readonly ruleset: FeedRuleset
  readonly policy: Readonly<FeedPolicy>
  resolve(request: FeedSpeedRequest): FeedSpeedResult
}

/** The F a move posts with: its own feed wins; a feed-less deferred role (today's
 *  fast_traverse and finish) takes its role row's rate; anything else stays feed-less
 *  so the machine boundary can refuse it as today. */
export function feedForMove(
  move: { feed?: number; role?: string },
  result: Pick<FeedSpeedResult, 'rates' | 'roles'>,
): number | undefined {
  if (typeof move.feed === 'number') return move.feed
  if (move.role === undefined || !Object.prototype.hasOwnProperty.call(ROLE_FEED_TABLE, move.role)) return undefined
  const role = move.role as LinkRole
  const rate = result.roles[role].rate
  return ROLE_FEED_TABLE[role].deferred && rate !== null ? result.rates[rate] : undefined
}

export function createFeedSpeedService(
  ruleset: FeedRuleset = PARITY_RULESET,
  policy: Readonly<FeedPolicy> = PARITY_FEED_POLICY,
): FeedSpeedService {
  const resolve = (req: FeedSpeedRequest): FeedSpeedResult => {
    const { tool, override: fo, machineRapidRate } = req
    const selection = selectCuttingData(tool, req.material, policy)
    // RC-019 at parity: today's feed stage reads the 'default' entry only.
    const feedEntry: FeedsAndSpeeds | undefined =
      policy.md75_material_entry || selection.how === 'default' ? selection.entry : undefined
    const feedEntryKey = feedEntry ? selection.key : null
    const reports: string[] = []
    const rates = {} as FeedRates
    const provenance = {} as Record<RoleRate, RateProvenance>

    for (const s of ruleset.stages) {
      let value: number
      let from: RateProvenance
      if (fo?.enabled) {
        const own = fo[s.overrideField]
        value = own == null && s.overrideAbsent !== undefined ? rates[s.overrideAbsent] : own as number
        from = { from: 'operation-override' }
      } else {
        const own = feedEntry?.[s.entryField] as number | null | undefined
        if (own != null) {
          value = own
          from = { from: 'cutting-data', key: feedEntryKey! }
        } else if (s.fallback.kind === 'safety') {
          value = s.fallback.value
          from = { from: 'safety-fallback', value }
          reports.push(`Tool "${tool.name}" has no ${s.entryField}; using ${value} mm/min.`)
        } else if (s.fallback.kind === 'derived') {
          const raw = rates[s.fallback.from] * s.fallback.factor
          value = s.fallback.round ? Math.round(raw) : raw
          from = { from: 'derived', stage: s.fallback.from }
        } else if (machineRapidRate != null) {
          value = machineRapidRate
          from = { from: 'machine-rapid' }
        } else {
          value = rates[s.fallback.from]
          from = { from: 'derived', stage: s.fallback.from }
        }
      }
      if (s.machineRapidCeiling && machineRapidRate != null) value = Math.min(value, machineRapidRate)
      rates[s.rate] = value
      provenance[s.rate] = from
    }

    if (policy.md77_chip_thinning && req.aeOverD !== undefined) {
      const kr = chipThinningFactor(req.aeOverD)
      if (kr < 1) {
        rates.feedRate = rates.feedRate / kr
        reports.push(`Cutting feed raised by chip thinning: ae ${req.aeOverD} D, Kr ${kr.toFixed(3)}.`)
      }
    }

    const requestedRpm = fo?.enabled ? fo.rpm : (selection.entry?.rpm ?? 0)
    // No stated minimum still means no negative speed (today's resolveSpindle).
    const aboveMinimum = Math.max(requestedRpm, req.machine?.minSpindleRpm ?? 0)
    const max = req.machine?.maxSpindleRpm
    const rpm = max === undefined ? aboveMinimum : Math.min(aboveMinimum, max)
    if (rpm !== requestedRpm) reports.push(`Spindle asked ${requestedRpm} rpm; posted ${rpm} within the machine's range.`)

    const query = { material: req.material, toolType: tool.type, diameterMm: tool.diameter, coating: tool.coating, rigidity: req.rigidity }
    const roles = Object.fromEntries(MOVE_ROLES.map(role => [role, roleFeed(ruleset, { role, ...query })])) as Record<LinkRole, RoleFeed>

    return {
      ruleset: { id: ruleset.id, version: ruleset.version },
      policy,
      selection,
      feedEntryKey,
      rates,
      rateProvenance: provenance,
      spindle: {
        requestedRpm, rpm,
        provenance: fo?.enabled ? 'operation-override' : selection.key === null || selection.entry?.rpm == null ? 'no cutting data' : { from: 'cutting-data', key: selection.key },
      },
      roles,
      reports,
    }
  }
  return { ruleset, policy, resolve }
}
