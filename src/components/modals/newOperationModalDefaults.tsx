import { textFor } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
// BK-178-DECOMP: pure configuration + defaults extracted verbatim from
// NewOperationModal.tsx. No hooks, no component state -- module-level constants,
// the Tab vocabulary, the tab strip config, the viewport accessor, and the
// per-op-type parameter defaults. Kept behaviour-identical (byte-for-byte
// values); this file only relocates them so the wizard body/hook modules can
// share one source of truth without the 5900-line component owning them inline.

import type { ReactNode } from 'react'
import { Layers, Wrench, SlidersHorizontal, Ruler, Link2, MousePointer2, Gauge } from 'lucide-react'
import type { FeedrateOverride, MachineConfig } from '../../types'
import { rpmInMachineRange } from '../../lib/machine/spindleRange'
import { useCamStore } from '../../store'
import type { VpHandle } from '../panels/DesignTree'

// ── Viewport accessor ─────────────────────────────────────────────────────────
export const getVp = (): VpHandle | null =>
  ((window as unknown as Record<string, unknown>).__cncViewport as VpHandle) ?? null

// ── Defaults ──────────────────────────────────────────────────────────────────

export {
  defaultHeights, defaultPasses, defaultLinking, defaultContourParams, defaultPocketParams, defaultACParams, defaultFaceParams, defaultEngraveParams, defaultVCarveParams, defaultDrillParams, defaultBoreParams, defaultThreadMillParams, defaultChamferParams,
} from '../../kernel/parameterDefaults'

/** The machine facts an operation's feed seed reads. */
export type FeedSeedMachine = Pick<MachineConfig, 'rapidRate' | 'minSpindleRpm' | 'maxSpindleRpm'>

/**
 * THE ONE FEED SEED (WO-1642) - the new-operation modal and the Properties
 * quick-edit card both start an override from here, so they cannot disagree.
 *
 * Pass the MACHINE, and the seed reads it: rpm lands inside that machine's
 * stated spindle range (the same clamp the post applies, so the number shown
 * is the number posted) and fast traverse defaults to its rapid. A bare number
 * is still accepted as the rapid for callers that only have that; the rpm is
 * then held inside the ACTIVE project's machine range, because a bare number
 * must never let a seed escape the spindle range the post will clamp to.
 */
export function defaultFeedrateOverride(
  tool?: { feedsAndSpeeds?: Record<string, { rpm?: number; feedRate?: number; plungeRate?: number; rampFeedrate?: number; leadInFeedrate?: number; leadOutFeedrate?: number; fastTraverseFeedrate?: number; finishFeedrate?: number }> },
  machine?: number | FeedSeedMachine,
): FeedrateOverride {
  const f = tool?.feedsAndSpeeds?.['default']
    ?? (tool?.feedsAndSpeeds ? Object.values(tool.feedsAndSpeeds)[0] : undefined)
  const feedRate   = f?.feedRate   ?? 1000
  const plungeRate = f?.plungeRate ?? 300
  const machineRapidRate = typeof machine === 'number' ? machine : machine?.rapidRate
  return {
    enabled:        false,
    rpm:            rpmInMachineRange(f?.rpm ?? 18000, typeof machine === 'number' ? activeMachine() : machine),
    feedRate,
    plungeRate,
    rampFeedrate:   f?.rampFeedrate    ?? Math.round(plungeRate * 1.5),
    leadInFeedrate: f?.leadInFeedrate  ?? feedRate,
    leadOutFeedrate:f?.leadOutFeedrate ?? feedRate,
    // Fast traverse defaults to the tool value, else the machine rapid rate (its ceiling).
    fastTraverseFeedrate: f?.fastTraverseFeedrate ?? machineRapidRate ?? 3000,
    // Finish defaults to the tool value, else the cutting feed (resolveFeedrates also
    // applies this cut-feed fallback). Empty/absent override = use cutting feed.
    finishFeedrate: f?.finishFeedrate ?? feedRate,
  }
}

function activeMachine(): FeedSeedMachine | undefined {
  return useCamStore.getState().project?.machine
}

export type Tab = 'type' | 'tool' | 'geometry' | 'passes' | 'heights' | 'linking' | 'feedrate'

export const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'type',     get label() { return tx('newOperationModalDefaults.Type_Name') }, icon: <Layers size={13} /> },
  { id: 'tool',     get label() { return tx('newOperationModalDefaults.Tool') },        icon: <Wrench size={13} /> },
  { id: 'geometry', get label() { return tx('newOperationModalDefaults.Geometry') },    icon: <MousePointer2 size={13} /> },
  { id: 'passes',   get label() { return tx('newOperationModalDefaults.Passes') },      icon: <SlidersHorizontal size={13} /> },
  { id: 'heights',  get label() { return tx('newOperationModalDefaults.Heights') },     icon: <Ruler size={13} /> },
  { id: 'linking',  get label() { return tx('newOperationModalDefaults.Linking') },     icon: <Link2 size={13} /> },
  { id: 'feedrate', get label() { return tx('newOperationModalDefaults.Feedrate') },    icon: <Gauge size={13} /> },
]
