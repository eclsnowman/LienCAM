// WO-3026 (alpha.3 A3-12): the one move-role vocabulary (12 roles, both lanes) with
// one feed row per role, and the 3D lane's 8 IR roles mapped onto it as today
// (parity policy `link.roles`; emitting all 12 directly in 3D is the MD-62 card).
//
// The rows record today's behaviour, measured on production runs (the parity test):
// the rate each role is fed at, whether the move carries its own feed (2.5D) or
// defers it to the output boundary, and the families that feed a role from another
// rate today. Those exceptions are kept, not fixed - fixing them is MD-62.

import type { MoveRole } from '../../types'
import { MOVE_MOTION_BY_ROLE, STOCK_CUTTING_BY_ROLE, type MoveMotion } from '../../lib/cam/stockCuttingRoles'
import type { IrMoveRole } from './ir'

/** The resolved rates a role can be fed at (today's ResolvedFeedrates keys). */
export type RoleRate =
  | 'feedRate'
  | 'plungeRate'
  | 'rampRate'
  | 'leadInRate'
  | 'leadOutRate'
  | 'fastTraverseRate'
  | 'finishRate'

/** The 12 roles, in the order src/types MoveRole declares them. */
export const MOVE_ROLES = [
  'rapid', 'cut', 'helix', 'ramp', 'plunge', 'stepover', 'fast_traverse',
  'lead_in', 'lead_out', 'retract', 'loop_back', 'wall_follow', 'finish',
] as const satisfies readonly MoveRole[]

export type LinkRole = (typeof MOVE_ROLES)[number]
// Closed both ways: a MoveRole missing from the list fails to compile here.
const VOCABULARY_IS_CLOSED: [Exclude<MoveRole, LinkRole>] extends [never] ? true : never = true
void VOCABULARY_IS_CLOSED

export interface RoleFeedRow {
  readonly role: LinkRole
  /** G0 for 'rapid', G1/G2/G3 at a feed for every other role. */
  readonly motion: 'rapid' | 'feed'
  /** Today's travel class (stockCuttingRoles MOVE_MOTION_BY_ROLE). */
  readonly travel: MoveMotion
  readonly stockCutting: boolean
  /** The rate the role is fed at; null for rapids. */
  readonly rate: RoleRate | null
  /** 2.5D: the engine leaves the move feed-less and the output boundary fills `rate`. */
  readonly deferred: boolean
  /** Families that feed this role from another rate - or, for 'rapid', at a feed - today
   *  (kept at parity; MD-62). */
  readonly parityExceptions: readonly RoleFeedException[]
}

export interface RoleFeedException {
  readonly family: string
  readonly rate: RoleRate
  /** Set when the family emits the role as a fed move although the row's motion is rapid. */
  readonly motion?: 'feed'
  readonly why: string
}

const row = (
  role: LinkRole, rate: RoleRate | null, deferred = false,
  parityExceptions: RoleFeedRow['parityExceptions'] = [],
): RoleFeedRow => Object.freeze({
  role,
  motion: role === 'rapid' ? 'rapid' : 'feed',
  travel: MOVE_MOTION_BY_ROLE[role],
  stockCutting: STOCK_CUTTING_BY_ROLE[role],
  rate, deferred, parityExceptions: Object.freeze(parityExceptions),
})

/** Exactly one feed row per role. */
export const ROLE_FEED_TABLE: Readonly<Record<LinkRole, RoleFeedRow>> = Object.freeze({
  rapid: row('rapid', null, false, [
    { family: 'drill', rate: 'feedRate', motion: 'feed', why: 'drill2d.ts:180 feeds the approach down to Feed Height at the cutting feed, tagged rapid' },
  ]),
  cut: row('cut', 'feedRate'),
  helix: row('helix', 'rampRate', false, [
    { family: 'thread_mill', rate: 'feedRate', why: 'the thread helix is the cut itself (threadmill2d.ts helixDescent feed: feedRate)' },
  ]),
  ramp: row('ramp', 'rampRate', false, [
    { family: 'chamfer', rate: 'plungeRate', why: 'chamfer2d.ts:211 rampTo(..., plungeRate)' },
  ]),
  plunge: row('plunge', 'plungeRate'),
  retract: row('retract', 'leadOutRate'), // preview-only; no CAM producer
  stepover: row('stepover', 'feedRate'),
  fast_traverse: row('fast_traverse', 'fastTraverseRate', true),
  lead_in: row('lead_in', 'leadInRate'),
  lead_out: row('lead_out', 'leadOutRate', false, [
    { family: 'chamfer', rate: 'feedRate', why: 'chamfer2d.ts exit move carries feedRate' },
  ]),
  loop_back: row('loop_back', 'feedRate'),
  wall_follow: row('wall_follow', 'feedRate'),
  finish: row('finish', 'finishRate', true),
})

/** Every role the kernel can emit has a row, and nothing else does. */
export function feedRowFor(role: string): RoleFeedRow {
  if (!Object.prototype.hasOwnProperty.call(ROLE_FEED_TABLE, role)) {
    throw new Error(`linking: unknown move role '${role}'`)
  }
  return ROLE_FEED_TABLE[role as LinkRole]
}

/** Parity `link.roles`: today's 3D IR roles map one-to-one onto the 12 (helix tagged ramp,
 *  keep-down ride tagged stepover - as today, BL-031 / BL-225). */
export const IR_ROLE_TO_LINK_ROLE: Readonly<Record<IrMoveRole, LinkRole>> = Object.freeze({
  rapid: 'rapid',
  cut: 'cut',
  plunge: 'plunge',
  ramp: 'ramp',
  lead_in: 'lead_in',
  lead_out: 'lead_out',
  stepover: 'stepover',
  finish: 'finish',
})

/** The 3D lane's feed row per IR role, as today's IR boundary resolves it. */
export const IR_ROLE_TO_RATE: Readonly<Record<Exclude<IrMoveRole, 'rapid'>, RoleRate>> = Object.freeze({
  cut: 'feedRate',
  plunge: 'plungeRate',
  ramp: 'rampRate',
  lead_in: 'leadInRate',
  lead_out: 'leadOutRate',
  stepover: 'feedRate',
  finish: 'finishRate',
})

/** Roles the 2.5D output boundary fills from the resolved rates (today's deferred set). */
export const DEFERRED_ROLES: readonly LinkRole[] = Object.freeze(
  MOVE_ROLES.filter(role => ROLE_FEED_TABLE[role].deferred),
)

/** The feed a 2.5D move ends up with at the output boundary: its own feed wins; a
 *  feed-less deferred role takes its row's rate; anything else stays feed-less. */
export function resolveRoleFeed(
  move: { feed?: number; role?: string },
  rates: Readonly<Record<RoleRate, number>>,
): number | undefined {
  if (typeof move.feed === 'number') return move.feed
  if (move.role === undefined) return undefined
  if (!Object.prototype.hasOwnProperty.call(ROLE_FEED_TABLE, move.role)) return undefined
  const entry = ROLE_FEED_TABLE[move.role as LinkRole]
  return entry.deferred && entry.rate !== null ? rates[entry.rate] : undefined
}
