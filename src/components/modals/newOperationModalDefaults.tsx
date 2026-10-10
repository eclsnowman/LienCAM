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
import type { HeightParams, PassParams, LinkingParams, FeedrateOverride, MachineConfig } from '../../types'
import type {
  ContourParams, PocketParams, DrillParams, BoreParams, ChamferParams, VCarveParams,
  FaceParams, EngraveParams, ACParams, ThreadMillParams,
} from '../../lib/cam/types'
import { DEFAULT_CONTOUR_TABS } from '../../lib/cam/types'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import { rpmInMachineRange } from '../../lib/machine/spindleRange'
import { useCamStore } from '../../store'
import type { VpHandle } from '../panels/DesignTree'

// ── Viewport accessor ─────────────────────────────────────────────────────────
export const getVp = (): VpHandle | null =>
  ((window as unknown as Record<string, unknown>).__cncViewport as VpHandle) ?? null

// ── Defaults ──────────────────────────────────────────────────────────────────

export const defaultHeights: HeightParams = {
  clearanceHeight: 15,
  clearanceHeightMode: 'absolute',
  retractHeight: 5,
  feedHeight: 5,
  topHeight: 0,
  topHeightMode: 'stock_top',
  bottomHeight: -5,
  bottomHeightMode: 'absolute',
  heightIntent: defaultHeightIntent(),
}

export const defaultPasses: PassParams = {
  stepdown: 2,
  stepover: 3,
  stockToLeave: 0,
  floorStockToLeave: 0,
  finishPasses: 1,
  springPasses: 0,
  overlapMm: 0,
}

export const defaultLinking: LinkingParams = {
  entryType: 'ramp_linear',
  rampAngle: 3,
  rampLength: 10,
  leadInRadius: 0,
  leadOutRadius: 0,
  retractType: 'full',
  transitionType: 'safe_height',
}

export const defaultContourParams: ContourParams = {
  side: 'outer',
  direction: 'climb',
  geometryId: '',
  loopIds: [],
  tabs: false,
  tabWidth: DEFAULT_CONTOUR_TABS.width,
  tabHeight: DEFAULT_CONTOUR_TABS.height,
  tabCount: DEFAULT_CONTOUR_TABS.count,
  // Bare 2D geometry supplies XY, not a physical floor. Start with one visible
  // conventional intent: 5 mm depth from stock top; model picks may infer more.
  heightReference: 'stock_top',
  planeOffset: -5,
}

export const defaultPocketParams: PocketParams = {
  geometryId: '',
  loopIds: [],
  // Boundary source mirrors facing (ADR 0015 §1). Default 'geometry' so existing
  // pockets are unchanged; 'stock' pockets the whole stock footprint.
  boundarySource: 'geometry',
  direction: 'climb',
  orderStrategy: 'by_region',
  fillStrategy: 'inside_out',
  floorStockToLeave: 0,
  finishContour: true,
  helixDiameter: 90,
  overlapMm: 1,
  stepoverLeadIn: 'arc',
  stayDown: false,
  stayDownLift: 1.0,
  heightReference: 'stock_top',
  planeOffset: -5,
}

// Adaptive Clearing (FreeCAD-port engine). The engine consumes helixDiameter
// (% of tool ⌀), tolerance (mm), rampAngle, the finish knobs (floorFinish/wallFinish/
// wallFinishMode -- 'final' | 'each_stepdown' | WO-1043's 'final_to_size'; ABSENT here, and
// absent means 'final', the mode that leaves the radial stock standing --
// /loopbackFilletPct/wallCleanupAsWeGo/integralWallFollow and its
// direct-ride length factor), plus
// shared PassParams (stepover/stepdown/stockToLeave/floorStockToLeave) and
// LinkingParams (entryType/rampAngle). The remaining fields are legacy
// bespoke-planner inputs the engine ignores; `climb` is retained as a direction
// compatibility bit and resolved to a physical direction at the UI/engine boundary.
export const defaultACParams: ACParams = {
  geometryId: '',
  loopIds: [],
  // Boundary source mirrors pocketing (ADR 0015 §1). Default 'geometry' so existing
  // adaptive ops are unchanged; 'stock' clears the whole stock footprint.
  boundarySource: 'geometry',
  targetEngagement: 0.4,   // legacy (engine ignores)
  maxEngagement: 0.6,      // legacy
  stepDistance: 1,         // legacy
  thetaMax: Math.PI / 3,   // legacy
  // Legacy compatibility bit: true preserves historical output, which is physically
  // conventional for Adaptive pocket boundaries. UI/engine resolve it explicitly.
  climb: true,
  rampAngle: 3,
  completionTolerance: 1,  // legacy
  helixDiameter: 90,       // % of tool diameter (engine-consumed)
  minHelixRadius: 0.2,     // mm; smaller planned helixes fall back to a plunge
  tolerance: 0.05,         // mm (engine-consumed)
  integralWallFollow: true, // stay down: ride the wall in place of a lift (engine-consumed; default ON)
  integralWallFollowLengthFactor: 2, // maximum direct wall ride = 200% of endpoint distance
  wallCleanupAsWeGo: false, // integrated finishing: ride+loopback at each wall transition (engine-consumed; default OFF)
  loopbackFilletPct: 25,    // loopback fillet radius as % of tool radius (engine-consumed; default 25)
  floorFinish: false,       // replay the adaptive stream once at true bottom (engine-consumed; default OFF)
  heightReference: 'stock_top',
  planeOffset: -5,
}

// Facing defaults. Full surface present (ADR 0015); deferred members carry inert
// values and are disabled in the UI. stepover/passExtension are auto-set from the
// tool (see the face auto-config effect). maxStayDownDistance is finite so it
// survives JSON persistence (Infinity → null).
export const defaultFaceParams: FaceParams = {
  boundarySource: 'stock', geometryId: '__stock__', loopIds: [],
  stockOffset: 0, boundaryContainment: 'outside', avoidanceLoopIds: [],
  pattern: 'zigzag', passAngle: 0, direction: 'both_ways', fromOtherSide: false,
  passExtension: 0, chipThinning: false,
  bothSidesPerLevel: true, floorStockToLeave: 0, finishPass: false,
  entryType: 'plunge', leadInRadius: 0, leadOutRadius: 0,
  keepToolDown: true, maxStayDownDistance: 50, extendBeforeRetract: true,
  transition: 'straight', tolerance: 0.01,
}

// Engrave / Trace defaults. Rides open curves on the line; closed loops accepted
// too. stepover is unused (path-following). Lead radii live on LinkingParams.
export const defaultEngraveParams: EngraveParams = {
  geometryId: '', loopIds: [], includeOpen: true, includeClosed: true,
  mode: 'engrave', depthModel: 'constant',
  side: 'center', sideOffset: 0, axialOffset: 0,
  targetLineWidth: 1, useWidthForDepth: false,
  direction: 'as_drawn',
  heightReference: 'stock_top', planeOffset: 0,
  tolerance: 0.01,
}

// V-carve defaults (WO-1174). Closed outlines only; the bit's own depth limit
// applies until the operator sets a flat depth; the V-bit clears its own
// flat floors with a 0.5 mm ring stepover.
export const defaultVCarveParams: VCarveParams = {
  geometryId: '', loopIds: [], role: 'carve',
  flatDepthMm: undefined, startDepthMm: 0, allowanceMm: 0,
  flatClearing: { mode: 'vbit', stepoverMm: 0.5 },
  tolerance: 0.01,
  heightReference: 'stock_top', planeOffset: 0,
}

export const defaultDrillParams: DrillParams = {
  geometryId: '',
  loopIds: [],
  cycleType: 'simple',
  peckDepth: 5,
  chipBreakRetract: 1,
  dwell: 0,
  retractMode: 'clearance',
  sortStrategy: 'nearest_neighbor',
  perHoleDepth: true,
  breakthroughMm: 0,
  heightReference: 'stock_top',
  planeOffset: -5,
}

export const defaultBoreParams: BoreParams = {
  geometryId: '',
  loopIds: [],
  direction: 'climb',
  sortStrategy: 'nearest_neighbor',
  geometrySource: 'loop',
  perBoreDepth: true,
  breakthroughMm: 0,
  heightReference: 'stock_top',
  planeOffset: -5,
}

// Thread milling. Mirrors drill's geometry/height pattern (loopIds = pre-cleared
// hole loops; heightReference = geometry_face like drill). Thread-specific fields
// per ThreadMillParams. External + control-comp are deferred (ADR-0015) — kept at
// inert defaults and greyed in the UI.
export const defaultThreadMillParams: ThreadMillParams = {
  geometryId: '',
  loopIds: [],
  threadKind: 'internal',
  externalReference: 'top',
  majorDiameter: 10,
  pitch: 1.5,
  handedness: 'right',
  cutDirection: 'climb',
  roughingPasses: 1,
  radialStepover: 1.0,
  springPasses: 0,
  leadInOut: 'arc',
  compensation: 'computer',
  heightReference: 'geometry_face',
  planeOffset: 0,
  threadDepth: 9,
  // Default = manual 2D-circle path (backward-safe). A 3D cylinder pick flips
  // this to 'cylinder' in runThreadCylinderDerive.
  geometrySource: 'loop',
}

export const defaultChamferParams: ChamferParams = {
  geometryId: '',
  loopIds: [],
  loopSides: {},
  direction: 'climb',
  chamferWidth: 1,
  tipOffset: 0,
  overlapMm: 1,
  heightReference: 'geometry_face',
  planeOffset: 0,
}

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
