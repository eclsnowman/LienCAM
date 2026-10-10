// Shared feed-hierarchy fixture data for the SIM-4 adaptive_3d fixture
// (feedHierarchy.sim4.test.ts) and its SIM-7 parallel_3d twin
// (feedHierarchy.parallel3d.test.ts) -- ONE tool/override/rate definition so
// the two "Machine -> Tool -> Operation Override reaches the frames" cases
// derive from the same numbers instead of hand-copied literals drifting apart.

import type { FeedrateOverride, Tool } from '../../types'
import { makeTool } from '../post/helpers'

export const MACHINE_RAPID_RATE = 5000
export const TOOL_CUT_RATE = 800
export const OVERRIDE_CUT_RATE = 900

export function hierarchyTool(): Tool {
  const tool = makeTool({ id: 'feed-hierarchy-tool', name: 'Feed hierarchy flat end mill' })
  return {
    ...tool,
    feedsAndSpeeds: {
      default: {
        ...tool.feedsAndSpeeds.default,
        feedRate: TOOL_CUT_RATE,
        plungeRate: 200,
        rampFeedrate: 300,
        leadInFeedrate: 400,
        leadOutFeedrate: 500,
        fastTraverseFeedrate: 2500,
        finishFeedrate: 600,
      },
    },
  }
}

export const operationOverride: FeedrateOverride = {
  enabled: true,
  rpm: 12000,
  feedRate: OVERRIDE_CUT_RATE,
  plungeRate: 225,
  rampFeedrate: 325,
  leadInFeedrate: 425,
  leadOutFeedrate: 525,
  fastTraverseFeedrate: 2750,
  finishFeedrate: 625,
}
