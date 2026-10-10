import type { Tool, FeedrateOverride, MoveRole, ToolpathMove } from '../../types'

export interface ResolvedFeedrates {
  feedRate:    number
  plungeRate:  number
  rampRate:    number
  leadInRate:  number
  leadOutRate: number
  /** Fast traverse (keep-down reposition through cleared stock). Resolved from the
   *  operation override or tool default, defaulted to and clamped by the machine rapid
   *  rate (the machine-above-operation hierarchy). */
  fastTraverseRate: number
  /** Dedicated wall-finishing pass (role 'finish'). Resolved from the operation override
   *  or tool default, FALLING BACK TO THE RESOLVED CUTTING FEED (not a separate safety
   *  constant) -- a finish pass without its own feed simply runs at the cutting feed. */
  finishRate: number
}

/** Feed-less moves are semantic requests from the CAM engine. Only these roles
 * deliberately defer their numeric feed to an output boundary; every other
 * feed move must keep carrying its own rate so a missing value still refuses. */
const DEFERRED_FEED_BY_ROLE: Partial<Record<MoveRole, keyof ResolvedFeedrates>> = {
  fast_traverse: 'fastTraverseRate',
  finish: 'finishRate',
}

/** Resolve a feed that an engine deliberately deferred by role. Explicit move
 * feeds always win, and unknown/malformed feed-less roles remain undefined so
 * the machine boundary can refuse them instead of guessing. */
export function resolveMoveFeedrate(
  move: ToolpathMove,
  feeds: ResolvedFeedrates,
): number | undefined {
  if (typeof move.feed === 'number') return move.feed
  if (move.role === undefined) return undefined
  const key = DEFERRED_FEED_BY_ROLE[move.role]
  return key === undefined ? undefined : feeds[key]
}

/** Return the original move unless a deferred role acquired its resolved feed. */
export function applyResolvedMoveFeed(
  move: ToolpathMove,
  feeds: ResolvedFeedrates,
): ToolpathMove {
  const feed = resolveMoveFeedrate(move, feeds)
  return feed === undefined || feed === move.feed ? move : { ...move, feed }
}

// Conservative safety fallbacks for genuinely degraded inputs only
// (hand-edited files, bad imports). These should never fire in
// production once upstream tool validation ensures
// tool.feedsAndSpeeds.default is always present. console.warn
// surfaces the gap so the user can fix the underlying tool config.
const SAFETY_FALLBACK_FEED_RATE   = 300  // mm/min
const SAFETY_FALLBACK_PLUNGE_RATE = 100  // mm/min

/**
 * Resolves feedrates via the two-tier chain: operation override (if
 * enabled) -> tool.feedsAndSpeeds.default.
 *
 * Required rates (feedRate, plungeRate) fall back to conservative
 * safety constants with console.warn if neither tier provides them.
 *
 * Derived rates (rampRate, leadInRate, leadOutRate) fall back
 * silently to geometry-based heuristics derived from already-resolved
 * feedRate/plungeRate.
 *
 * Fast traverse follows the full machine-above-operation hierarchy: the operation
 * override (if enabled) or the tool default provides the value, the machine rapid rate
 * (`machineRapidRate`, when supplied) is both its default and its ceiling. The caller in
 * the engine worker has no machine and omits it; the store consumer passes it so the
 * estimate/sim/postprocessor get the clamped, machine-bounded value.
 */
export function resolveFeedrates(
  tool: Tool,
  override: FeedrateOverride | undefined,
  machineRapidRate?: number,
): ResolvedFeedrates {
  const fo        = override
  const toolFeeds = tool.feedsAndSpeeds?.default

  let feedRate: number
  if (fo?.enabled) {
    feedRate = fo.feedRate
  } else if (toolFeeds?.feedRate != null) {
    feedRate = toolFeeds.feedRate
  } else {
    console.warn(
      `[resolveFeedrates] Tool "${tool.name}" missing feedsAndSpeeds.default.feedRate. ` +
      `Using safety fallback value ${SAFETY_FALLBACK_FEED_RATE} mm/min. ` +
      `Set tool defaults to suppress this warning.`
    )
    feedRate = SAFETY_FALLBACK_FEED_RATE
  }

  let plungeRate: number
  if (fo?.enabled) {
    plungeRate = fo.plungeRate
  } else if (toolFeeds?.plungeRate != null) {
    plungeRate = toolFeeds.plungeRate
  } else {
    console.warn(
      `[resolveFeedrates] Tool "${tool.name}" missing feedsAndSpeeds.default.plungeRate. ` +
      `Using safety fallback value ${SAFETY_FALLBACK_PLUNGE_RATE} mm/min. ` +
      `Set tool defaults to suppress this warning.`
    )
    plungeRate = SAFETY_FALLBACK_PLUNGE_RATE
  }

  const rampRate    = fo?.enabled ? fo.rampFeedrate    : (toolFeeds?.rampFeedrate    ?? Math.round(plungeRate * 1.5))
  const leadInRate  = fo?.enabled ? fo.leadInFeedrate  : (toolFeeds?.leadInFeedrate  ?? feedRate)
  const leadOutRate = fo?.enabled ? fo.leadOutFeedrate : (toolFeeds?.leadOutFeedrate ?? feedRate)

  // Fast traverse: operation override / tool default, defaulted to and clamped by the
  // machine rapid rate. With no machine ceiling supplied (worker path), it is left
  // unclamped and falls back to the cutting feed -- harmless, since that path does not
  // consume it (the move carries the type only, no feed).
  const ftRaw = fo?.enabled
    ? fo.fastTraverseFeedrate
    : (toolFeeds?.fastTraverseFeedrate ?? machineRapidRate ?? feedRate)
  const fastTraverseRate = machineRapidRate != null ? Math.min(ftRaw, machineRapidRate) : ftRaw

  // Finish: operation override / tool default, defaulting to the resolved CUTTING feed.
  // The user wants the wall-finish role to "default to cut feedrate", so the absence of an
  // explicit finish feed is not a degraded input -- it just rides the cutting feed.
  const finishRate = fo?.enabled
    ? (fo.finishFeedrate ?? feedRate)
    : (toolFeeds?.finishFeedrate ?? feedRate)

  return { feedRate, plungeRate, rampRate, leadInRate, leadOutRate, fastTraverseRate, finishRate }
}
