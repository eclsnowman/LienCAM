import type { HeightParams, PassParams, LinkingParams, Tool, ToolHolder, ToolpathMove, FeedrateOverride } from '../../types'
import type { NestPart, NestStyle, Spacing, SolverMode, Placement } from './nesting/types'
import type { PatternMachineLimits } from './pattern2d/types'

export type { ToolpathMove }

// ── Holder/shank crash-guard inputs (WO-276) ─────────────────────────────────
//
// Every 2D toolpath request carries what the holder crash check needs, because
// the guard runs ONCE in toolpathWorker.ts for every strategy rather than at
// per-strategy call sites (that shape is how assertToolFluteReach ended up with
// six call sites and a ninth strategy that could miss it). The tool already
// carries its stickout (Tool.lengthBelowHolder); only the resolved holder
// profile and the stock block were missing.

/** The raw stock block, in the SAME absolute frame the builders emit moves in
 *  (world/machine coordinates — the frame resolveHeights produces, and the same
 *  frame ContourWorkerPayload.stockBounds already uses). */
export interface ToolpathStockBlock {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
}

export interface HolderClearanceInputs {
  /** Holder profile resolved from Tool.holderId at dispatch. Absent means the
   *  tool has no holder assigned (or it could not be resolved) — the guard then
   *  reports "not checked", never a clear. */
  holder?: ToolHolder
  /** Active stock as loaded. Absent when the setup has no resolvable stock —
   *  again "not checked", never a clear. */
  stockBlock?: ToolpathStockBlock
}

// -- Setup fixture stack and support plane -----------------------------------

/** A setup-owned physical layer, ordered from the machine table upward. */
export type FixtureStackItemType =
  | 'spoilboard'
  | 'vise'
  | 'fixed_jaw'
  | 'soft_jaw'
  | 'custom'

export interface FixtureStackItem {
  id: string
  name: string
  type: FixtureStackItemType
  /** Physical thickness/height in canonical millimeters. */
  height: number
  /** Display-only. Hidden layers still physically support everything above. */
  visible: boolean
}

export type SetupSupportPlaneMode =
  | 'machine_table'
  | 'spoilboard'
  | 'vise_bed'
  | 'fixed_jaw_shelf'
  | 'soft_jaw_step'
  | 'stock_bottom'
  | 'custom'

export interface SetupSupportPlane {
  mode: SetupSupportPlaneMode
  /** Signed distance above/below the selected base plane, in millimeters. */
  offset: number
  /** Scene Z used only by custom mode. */
  customZ?: number
}

export interface ResolvedSetupSupportPlane {
  mode: SetupSupportPlaneMode
  name: string
  z: number
  wcsLabel: string
  /** support-plane scene Z minus the active WCS origin scene Z. */
  wcsOffsetZ: number
  resolved: boolean
  missingReason?: string
}

export const DEFAULT_SETUP_SUPPORT_PLANE: Readonly<SetupSupportPlane> = {
  mode: 'machine_table',
  offset: 0,
}

const SUPPORT_PLANE_LABELS: Record<SetupSupportPlaneMode, string> = {
  machine_table: 'Machine table',
  spoilboard: 'Spoilboard top',
  vise_bed: 'Vise bed',
  fixed_jaw_shelf: 'Fixed-jaw shelf',
  soft_jaw_step: 'Soft-jaw step',
  stock_bottom: 'Stock bottom',
  custom: 'Custom plane',
}

const STACK_PLANE_ITEM_TYPE: Partial<Record<SetupSupportPlaneMode, FixtureStackItemType>> = {
  spoilboard: 'spoilboard',
  vise_bed: 'vise',
  fixed_jaw_shelf: 'fixed_jaw',
  soft_jaw_step: 'soft_jaw',
}

const FIXTURE_STACK_ITEM_TYPES = new Set<FixtureStackItemType>([
  'spoilboard', 'vise', 'fixed_jaw', 'soft_jaw', 'custom',
])
const SETUP_SUPPORT_PLANE_MODES = new Set<SetupSupportPlaneMode>([
  'machine_table', 'spoilboard', 'vise_bed', 'fixed_jaw_shelf',
  'soft_jaw_step', 'stock_bottom', 'custom',
])

export function setupFixtureStack(setup: { fixtureStack?: FixtureStackItem[] }): FixtureStackItem[] {
  if (!Array.isArray(setup.fixtureStack)) return []
  return setup.fixtureStack
    .filter((item) => item != null && typeof item === 'object')
    .map((item, index) => ({
      id: typeof item.id === 'string' && item.id !== '' ? item.id : `fixture-layer-${index + 1}`,
      name: typeof item.name === 'string' ? item.name : `Fixture layer ${index + 1}`,
      type: FIXTURE_STACK_ITEM_TYPES.has(item.type) ? item.type : 'custom',
      height: Number.isFinite(item.height) && item.height >= 0 ? item.height : 0,
      visible: item.visible !== false,
    }))
}

export function setupSupportPlane(
  setup: { supportPlane?: SetupSupportPlane },
): SetupSupportPlane {
  const stored = setup.supportPlane
  const mode = stored && SETUP_SUPPORT_PLANE_MODES.has(stored.mode)
    ? stored.mode
    : DEFAULT_SETUP_SUPPORT_PLANE.mode
  return {
    mode,
    offset: Number.isFinite(stored?.offset) ? stored!.offset : 0,
    ...(Number.isFinite(stored?.customZ) ? { customZ: stored!.customZ } : {}),
  }
}

/**
 * Resolve the display/reference plane only. This function deliberately never
 * reads or mutates operations, stock placement, part placement, or WCS origin.
 */
export function resolveSetupSupportPlane(
  setup: {
    wcs: { label: string; origin: { z: number } }
    fixtureStack?: FixtureStackItem[]
    supportPlane?: SetupSupportPlane
  },
  stockBottomZ?: number,
): ResolvedSetupSupportPlane {
  const plane = setupSupportPlane(setup)
  const stack = setupFixtureStack(setup)
  const name = SUPPORT_PLANE_LABELS[plane.mode]
  let baseZ = 0
  let resolved = true
  let missingReason: string | undefined

  if (plane.mode === 'stock_bottom') {
    if (Number.isFinite(stockBottomZ)) baseZ = stockBottomZ!
    else {
      resolved = false
      missingReason = 'The setup has no bound stock bottom to reference.'
    }
  } else if (plane.mode === 'custom') {
    if (Number.isFinite(plane.customZ)) baseZ = plane.customZ!
    else {
      resolved = false
      missingReason = 'Enter a finite custom plane Z.'
    }
  } else {
    const targetType = STACK_PLANE_ITEM_TYPE[plane.mode]
    if (targetType) {
      let cumulative = 0
      let matched = false
      for (const item of stack) {
        const height = Number.isFinite(item.height) && item.height >= 0 ? item.height : 0
        cumulative += height
        if (item.type === targetType) {
          baseZ = cumulative
          matched = true
        }
      }
      if (!matched) {
        resolved = false
        missingReason = `Add a ${name.toLowerCase()} layer to the fixture stack.`
      }
    }
  }

  const z = baseZ + plane.offset
  return {
    mode: plane.mode,
    name,
    z,
    wcsLabel: setup.wcs.label,
    wcsOffsetZ: z - setup.wcs.origin.z,
    resolved,
    ...(missingReason ? { missingReason } : {}),
  }
}

// The canonical Setup interface is declared in src/types/index.ts, outside
// this work order's lane. That module already imports this file for CAM types,
// so declaration merging keeps the setup record typed without a lane escape.
declare module '../../types' {
  interface Setup {
    fixtureStack?: FixtureStackItem[]
    supportPlane?: SetupSupportPlane
  }
}

// ── ModelReference (CAM-1, docs/3d-modeling-plan.md §3.8) ────────────────────
//
// A typed, persisted reference from a CAM operation to B-rep MODEL geometry.
// This is the moat feature: "parametric edit -> toolpath knows". On model regen
// the re-resolution hook (src/lib/cam/modelReferenceResolution.ts) re-resolves
// every ModelReference through the FROZEN geom-service resolve()
// (src/geom/geom-service.ts:513) and flips the owning op:
//   - stale  (status 'outdated') when its referenced geometry still exists but
//     moved / the body regenerated -> needs a re-post;
//   - degraded (status 'degraded', RED) when a referenced subshape is GONE ->
//     the op keeps its last-known toolpath and never silently recomputes.
//
// SCOPE FENCE (CAM-1): this WO ships the TYPE, the re-resolution hook and the
// flags/badges only. POPULATING modelReferences on an op (boundary extraction,
// stock definition, setup-origin binding) is CAM-2.

/** What a ModelReference is FOR. Closed enum.
 *  'drill-targets' (CAM-DRILL-ADAPTER): Model-kernel recognized holes bound as
 *  drill centres; `stableIds` carry the hole features' ElementMap face ids so
 *  CAM-1 re-resolution can amber/red the op when a hole face moves or vanishes.
 *  'bore-target' binds one explicitly selected internal cylindrical wall.
 *  'edge-chain' (WO-208): a set of picked modeled-body edges that close into a
 *  contour. Its source identity (`modelItemId` + `bodyId`) is load-bearing: an
 *  edge chain names a contour only on the body and Model Item it was picked on. */
export type ModelReferenceRole =
  | 'machining-boundary' | 'stock' | 'origin' | 'avoid' | 'drill-targets' | 'bore-target' | 'edge-chain'

/** One selected Bore feature. Wall ids remain the durable topology authority;
 * geometric identity/fingerprint records what the operator detected. */
export interface ModelBoreFeatureBinding {
  /** Smart Height's last proven body leaf; wall identity remains stable across
   * later leaf changes and undo. Absent on pre-refresh bindings. */
  bodyId?: string
  /** Imported STEP correspondence proved this complete cylindrical wall's rim
   * from its analytic area and bounding-box midpoint, rather than stack entry. */
  wallRim?: boolean
  featureId: string
  sourceKey: string
  faceStableId: string
  loopId: string
  sourceVersion: number
  sourceFingerprint: string
}

export interface ModelReference {
  /** Stable id of the B-rep body the referenced subshapes live on. */
  bodyId: string
  /** Model Item scope for `bodyId`. Omitted references belong to the legacy
   *  item; omission never means "any item". */
  modelItemId?: string
  /** Stable ids (faces / edges / vertices) on that body this op depends on.
   *  Re-resolved against the kernel through the frozen resolve() on regen. */
  stableIds: string[]
  /** Role drives nothing in CAM-1's mapping today (a lost id degrades the op
   *  regardless of role); it is carried for CAM-2's role-specific handling. */
  role: ModelReferenceRole
  /** WO-3169: explicit multi-feature spelling; absent preserves legacy one-wall semantics. */
  boreFeatures?: ModelBoreFeatureBinding[]
}

/** WO-2287: how Pocket and closed Contour relieve the inside corners a round cutter
 *  cannot reach. 'dogbone' cuts along the corner bisector, 't_bone' along the adjacent
 *  edge nearer parallel to X, 'longest_edge' along the longer adjacent edge; each ends
 *  where the cutter just touches the corner (src/lib/cam/cornerRelief2d.ts). */
export type CornerReliefStyle = 'none' | 'dogbone' | 't_bone' | 'longest_edge'

// ── Contour 2D ───────────────────────────────────────────────────────────────

/** One loop's holding-tab locations: center fractions, or 'none' (WO-3220). */
export type ContourTabLocations = number[] | 'none'

export interface ContourParams {
  /** Closed is the legacy/default contour planner. Open machines only open
   *  chains and uses stock-edge entry/exit linking. */
  pathType?: 'closed' | 'open'
  /** Physical cutter side relative to the source chain's point order.
   *  Absent resolves to right for backward compatibility. */
  openSide?: 'left' | 'right'
  side: 'outer' | 'inner'
  direction: 'climb' | 'conventional'
  geometryId: string
  loopIds: string[]   // empty → all closed loops in the geometry
  tabs: boolean
  /** Holding-tab width along the finished contour (mm). Optional for legacy
   *  projects; enabled tabs default through DEFAULT_CONTOUR_TABS. */
  tabWidth?: number
  /** Material height retained above the stock bottom (mm). */
  tabHeight?: number
  /** Number of tabs placed evenly around each selected closed contour. */
  tabCount?: number
  /** Holding-tab profile along the contour. 'box' (default, legacy) lifts
   *  vertically to the tab top, feeds across, and plunges back down;
   *  'triangular' feeds up a 45 deg ramp, across the tab top, and down the
   *  far ramp with no vertical Z steps.
   *  Absent/undefined resolves to 'box' (byte-identical legacy output). */
  tabShape?: 'box' | 'triangular'
  /** USER-PLACED holding-tab centers, keyed by loop id. Each value is a
   *  FRACTION in [0, 1) of that loop's finish-contour perimeter — the arc
   *  distance of the TAB CENTER along the cut direction from the contour seam
   *  (the finish path's first point), sorted ascending. A loop with a
   *  non-empty entry places its tabs at exactly these centers and IGNORES
   *  tabCount; an absent or empty entry keeps the evenly-spaced default
   *  (byte-identical legacy output). Optional + additive: absent on older
   *  projects, verbatim (de)serialization, no schema-version bump (same
   *  precedent as tabShape/floorStockToLeave).
   *  WO-3220: the value 'none' means NO tabs on that loop. Only an applied
   *  tab suggestion writes it, for a loop where the suggestion found no safe
   *  place, so the cut matches the accepted partial plan instead of falling
   *  back to even spacing. Absent and [] still mean even spacing. */
  tabLocations?: { [loopId: string]: ContourTabLocations }
  /** Which plane the bottom of cut sits on. Resolved to bottomHeight (WCS)
   *  before dispatch (mirrors PocketParams). Absent (older projects) → the op
   *  falls back to bottomHeightMode/absolute resolution (no behavior change). */
  heightReference?: ChamferHeightReference
  /** Fine-tune offset from the reference plane (mm). Positive = above, negative = below. */
  planeOffset?: number
  /** Datum surface for heightReference 'picked_plane': the operator clicked a model
   *  face; its model-local Z is the reference plane (planeOffset then applies on top).
   *  Distinct from heights.selectedFaceZ (the smart bottom-override) so the two never
   *  collide. Undefined unless heightReference === 'picked_plane'. */
  referencePlaneGeo?: { geoId: string; faceIndex: number; localZ: number }
  /** Where the finish pass runs when roughing is on: 'final' = once at full depth
   *  (default; byte-identical to prior behavior); 'each_stepdown' = a finish pass at
   *  every depth level. Mirrors ACParams.wallFinishMode. Absent/undefined → 'final'.
   *  No effect when roughing is off (the no-roughing branch always finishes at every
   *  depth). UI selector lands separately. */
  contourFinishMode?: 'final' | 'each_stepdown'
  /** WO-2287: corner relief cut after the main path into every inside corner the
   *  cutter cannot reach (closed contours only). Absent/undefined resolves to 'none'
   *  (byte-identical legacy output); verbatim (de)serialization, no schema bump. */
  cornerRelief?: CornerReliefStyle
  /** WO-2317: Gentle corner - cut each relief as a lobe a little wider than the tool
   *  in small trochoidal orbits, so the cutter never takes more than
   *  `cornerReliefEngagement` mm of width. Absent/false = the straight cut (unchanged). */
  cornerReliefGentle?: boolean
  /** WO-2317: Max engagement (mm) for a gentle corner; absent follows the tool (0.25 D). */
  cornerReliefEngagement?: number
  /** WO-2289: how a closed contour's rough pass is traced at each level. 'offset'
   *  (default) is one offset loop; 'trochoidal' cuts a channel `trochoidalWidth`
   *  wide in overlapping orbits that advance `trochoidalAdvance` per orbit.
   *  Absent resolves to 'offset' (byte-identical legacy output). Only applies
   *  when the cutting strategy has roughing. */
  roughingStyle?: ContourRoughingStyle
  /** Trochoidal channel width (mm). Absent follows the tool: 1.5 x its diameter. */
  trochoidalWidth?: number
  /** Trochoidal centre advance per orbit (mm). Absent follows the tool: 0.1 x its diameter. */
  trochoidalAdvance?: number
  /** WO-3221: present only on a tab removal contour made by Create tab removal
   *  contour. It names the tabbed Contour whose tabs this one cuts away and the
   *  tabs it targets. Absent on every other contour (older projects unchanged).
   *  Its presence makes the operation depend on its predecessors; a malformed
   *  value is refused at compute, never read as an ordinary contour. */
  tabRemovalSource?: ContourTabRemovalSource
}

/** WO-3221: one holding tab a tab removal contour targets, resolved from the
 *  source's own tab plan (buildContourTabPlan, re-seaming included). */
export interface ContourTabRemovalTarget {
  loopId: string
  /** `${loopId}#${k}` (the WO-3004 tab index): display only, ordinal, never an identity. */
  label: string
  /** Tab center on the source's finish path, world XY mm. */
  center: { x: number; y: number }
  width: number
  height: number
  shape: 'box' | 'triangular'
}

/** WO-3221: the link from a tab removal contour to the tabbed Contour it cleans up. */
export interface ContourTabRemovalSource {
  version: 1
  sourceSetupId: string
  sourceOperationId: string
  /** The source's authored cut inputs when the cleanup was created (outline,
   *  side, direction, tabs and their locations, heights, tool size and hand).
   *  A target is this identity + its loop + its center/profile, so a later
   *  tab #1 never silently stands in for an earlier tab #1. */
  sourceIdentity: string
  /** The outlines that carry the targeted tabs; the cleanup cuts exactly these. */
  loopIds: string[]
  targets: ContourTabRemovalTarget[]
}

/** WO-2289: the Contour Roughing style choices. */
export type ContourRoughingStyle = 'offset' | 'trochoidal'
export const CONTOUR_ROUGHING_STYLE_LABELS: Record<ContourRoughingStyle, string> = {
  offset: 'Offset',
  trochoidal: 'Trochoidal',
}

export const DEFAULT_CONTOUR_TABS = {
  width: 8,
  height: 2,
  count: 4,
} as const

/** The four cutting strategies the Contour "Passes" tab exposes as ONE explicit
 *  dropdown (replacing the entangled enableRoughing + enableFinish checkboxes).
 *  Encoding these as a single mode makes the illegal "no cut at all"
 *  (stockToLeave=0 && finishPasses=0) combination unreachable by construction.
 *  - cut_at_geometry  : no roughing; the single profile pass IS the cut
 *                       (finishPasses pinned to 1). Repeats are spring passes,
 *                       not finish passes — there is no roughing to finish.
 *  - roughing_only    : leave stock on the wall, no finish pass.
 *  - rough_finish_each : rough + a finish pass at EVERY depth (each_stepdown).
 *  - rough_finish_final: rough + a single finish pass at the final depth. */
export type ContourCuttingStrategy =
  | 'cut_at_geometry'
  | 'roughing_only'
  | 'rough_finish_each'
  | 'rough_finish_final'

/** The {stockToLeave, finishPasses, contourFinishMode} a contour op emits for a
 *  given strategy. `prev` carries the user's last-entered stock-to-leave /
 *  finish-pass counts so toggling modes preserves their numbers (clamped to a
 *  legal minimum). EVERY branch produces a real cut — no path can yield
 *  stockToLeave=0 && finishPasses=0 (see ContourCuttingStrategy). */
export function contourPassParamsForMode(
  mode: ContourCuttingStrategy,
  prev: { stockToLeave: number; finishPasses: number },
): { stockToLeave: number; finishPasses: number; contourFinishMode?: 'final' | 'each_stepdown' } {
  const rough  = Math.max(0.01, prev.stockToLeave)
  const finish = Math.max(1, prev.finishPasses)
  switch (mode) {
    case 'cut_at_geometry':
      // No roughing: the single profile pass IS the cut, so finishPasses is
      // pinned to exactly 1 (not max(1, prev)). Repeats live in spring passes.
      return { stockToLeave: 0, finishPasses: 1 }
    case 'roughing_only':
      return { stockToLeave: rough, finishPasses: 0 }
    case 'rough_finish_each':
      return { stockToLeave: rough, finishPasses: finish, contourFinishMode: 'each_stepdown' }
    case 'rough_finish_final':
      return { stockToLeave: rough, finishPasses: finish, contourFinishMode: 'final' }
  }
}

/** Derive the dropdown's strategy from an existing op's params, so editing an
 *  op shows the mode it was saved with. Mirrors contourPassParamsForMode.
 *  Legacy ops that somehow carry no cut (both zero) default to cut_at_geometry. */
export function deriveContourMode(
  passes: { stockToLeave?: number; finishPasses?: number },
  contourFinishMode?: 'final' | 'each_stepdown',
): ContourCuttingStrategy {
  const hasRough  = (passes.stockToLeave ?? 0) > 0
  const hasFinish = (passes.finishPasses ?? 0) > 0
  if (hasRough && hasFinish) {
    return contourFinishMode === 'each_stepdown' ? 'rough_finish_each' : 'rough_finish_final'
  }
  if (hasRough && !hasFinish) return 'roughing_only'
  if (!hasRough && hasFinish) return 'cut_at_geometry'
  return 'cut_at_geometry' // legacy: neither set -> safe default
}

// ── Pocket 2D ────────────────────────────────────────────────────────────────

/** Where the pocket boundary (the region to clear) comes from. Mirrors a SUBSET
 *  of FaceBoundarySource (ADR 0015 §1): 'geometry' = the selected closed loop(s)
 *  (today's behavior, the default), 'stock' = the whole stock footprint. There is
 *  deliberately no 'rest' here. Boss/island avoidance is a SEPARATE later chunk
 *  and is NOT implied by 'stock'. */
export type PocketBoundarySource = 'geometry' | 'stock'

export interface PocketParams {
  geometryId: string
  loopIds: string[]             // empty → all closed loops in the geometry
  /** Boundary source (mirrors facing). Absent (older projects) === 'geometry',
   *  so existing pockets are byte-identical until the user picks Stock. */
  boundarySource?: PocketBoundarySource
  direction: 'climb' | 'conventional'
  orderStrategy: 'by_depth' | 'by_region'
  fillStrategy?: 'outside_in' | 'inside_out'  // concentric ring order; default outside_in
  floorStockToLeave: number     // mm stock left on floor (separate from wall stock in PassParams)
  finishContour: boolean        // run a finish pass around the pocket wall at final depth
  helixDiameter: number         // helix path diameter as % of tool diameter (0–95)
  /** mm to extend past the ring seam before stepping to the next ring (prevents witness marks). */
  overlapMm: number
  /** How to transition between concentric rings: direct feed or tangential arc. */
  stepoverLeadIn: 'none' | 'arc'
  /** Stay-down: instead of retracting to clearance height before the finish contour
   *  pass, lift by stayDownLift mm and feed across at that height. Saves air time. */
  stayDown: boolean
  /** How far to lift (mm) for stay-down transitions. Default 1.0. */
  stayDownLift: number
  /** WO-1972: how far (mm) above the material still standing a helix entry
   *  begins - the highest remaining stock under the helix, or the level this
   *  pocket just cut. Absent = 1.0. */
  entryClearance?: number
  /** Which plane the bottom of cut sits on. Resolved to bottomHeight (WCS) before dispatch. */
  heightReference?: ChamferHeightReference
  /** Fine-tune offset from the reference plane (mm). Positive = above, negative = below. */
  planeOffset?: number
  /** Datum surface for heightReference 'picked_plane': the operator clicked a model
   *  face; its model-local Z is the reference plane (planeOffset then applies on top).
   *  Distinct from heights.selectedFaceZ (the smart bottom-override) so the two never
   *  collide. Undefined unless heightReference === 'picked_plane'. */
  referencePlaneGeo?: { geoId: string; faceIndex: number; localZ: number }
  /** WO-2287: corner relief cut after the main path into every inside corner of the
   *  pocket wall and every reflex corner of an island. Absent/undefined resolves to
   *  'none' (byte-identical legacy output); verbatim (de)serialization, no schema bump. */
  cornerRelief?: CornerReliefStyle
  /** WO-2317: Gentle corner - see ContourParams.cornerReliefGentle. */
  cornerReliefGentle?: boolean
  /** WO-2317: Max engagement (mm) for a gentle corner; absent follows the tool (0.25 D). */
  cornerReliefEngagement?: number
  /** WO-2291: Slot feed, percent of the cutting feed (1-100) a cut runs at where the
   *  cutter is buried full width; the feed eases back to 100% as engagement falls to
   *  what the stepover gives. Absent/100 = every cut at the cutting feed (byte-identical). */
  slotFeedPercent?: number
  /** WO-2296: Rounded ring corners - each clearing ring takes its corners as arcs
   *  wherever the ring outside it already cuts what the arc skips (the wall ring
   *  keeps its corners). Absent/false = sharp rings (byte-identical). */
  roundRingCorners?: boolean
}

// ── Drill ─────────────────────────────────────────────────────────────────────

export interface DrillParams {
  geometryId: string
  loopIds: string[]                              // closed loops whose centroids are drill centres
  cycleType: 'simple' | 'peck' | 'chip_break' | 'dwell'
  peckDepth: number                              // mm — axial increment per peck (peck + chip_break)
  chipBreakRetract: number                       // mm — partial retract for chip-break (G73)
  /** mm — shave this much off each successive peck (peck + chip_break). When a
   *  positive finite number the pecks shrink from peckDepth toward minPeckDepth.
   *  Undefined/0 = constant pecks (today's output, byte-identical). WO-1926. */
  peckDecrement?: number
  /** mm — floor a shrinking peck never gets smaller than (peck + chip_break).
   *  Only meaningful while peckDecrement is a positive number; when absent the
   *  floor defaults to the decrement so a shrinking sequence always progresses. */
  minPeckDepth?: number
  dwell: number                                  // seconds — pause at hole bottom (G82)
  retractMode: 'clearance' | 'retract'           // Z-height used for between-hole rapids
  sortStrategy: 'none' | 'nearest_neighbor' | 'by_x' | 'by_y'
  /** Drill each hole to its own detected or selected cylindrical-wall bottom.
   *  Defined for B-rep detected holes and picked internal bore walls;
   *  the store resolves per-target bottoms into the payload's holeBottoms map.
   *  Not a Z param — depths ride as payload DATA per ADR 0002. */
  perHoleDepth?: boolean
  /** Which plane the bottom of cut (hole bottom) sits on. Resolved to
   *  bottomHeight (WCS) before dispatch (mirrors PocketParams). Per-hole depths
   *  (perHoleDepth) and the B-rep selected_face binding both take precedence.
   *  Absent (older projects) → bottomHeightMode/absolute resolution. */
  heightReference?: ChamferHeightReference
  /** Manual per-hole bottom override, keyed by loop id. WCS-RELATIVE — same
   *  convention as holeBottoms / heights.bottomHeight (absolute Z = value +
   *  wcsOrigin.z). Wins over the perHoleDepth-detected bottom AND the op-level
   *  bottom. Absent/empty = no override (today's behavior). Additive — depths
   *  ride as DATA, never a new Z name (ADR 0002); old projects have none and
   *  resolve to detected/op-level (ADR 0027 migration framework). */
  perHoleDepthOverrides?: { [loopId: string]: number }
  /** Additional axial travel past each detected physical floor. Applied once,
   * after drill-point compensation. Ignored by explicit-depth Smart Height. */
  breakthroughMm?: number
  /** Fine-tune offset from the reference plane (mm). Positive = above, negative = below. */
  planeOffset?: number
  /** Datum surface for heightReference 'picked_plane': the operator clicked a model
   *  face; its model-local Z is the reference plane (planeOffset then applies on top).
   *  Distinct from heights.selectedFaceZ (the smart bottom-override) so the two never
   *  collide. Undefined unless heightReference === 'picked_plane'. */
  referencePlaneGeo?: { geoId: string; faceIndex: number; localZ: number }
}

export interface DrillWorkerPayload extends HolderClearanceInputs {
  opId: string
  setupId: string
  params: DrillParams
  heights: HeightParams
  passes: PassParams
  linking: LinkingParams
  tool: Tool
  loops: LoopData[]
  wcsOrigin: { x: number; y: number; z: number }
  feedrateOverride?: FeedrateOverride
  /** Per-hole bottom heights keyed by loop id, WCS-RELATIVE (same convention as
   *  heights.bottomHeight: absolute Z = value + wcsOrigin.z, mirroring
   *  resolveHeights). Built by the store from HoleFeature.bottomZ or an internal
   *  CylinderFeature.bottomZ when params.perHoleDepth is set; loops absent from
   *  the map use the op-level bottom plane. */
  holeBottoms?: { [loopId: string]: number }
}

// ── Bore (INT-17A-R5 C1) ─────────────────────────────────────────────────────
//
// Bore supports circular 2D loops and imported STEP cylinders. Keep
// `geometryId` as the canonical geometry-owner field for contract checks.
export interface BoreParams {
  geometryId: string
  loopIds: string[]
  direction: 'climb' | 'conventional'
  sortStrategy: 'none' | 'nearest_neighbor' | 'by_x' | 'by_y'
  geometrySource?: 'cylinder' | 'loop'
  targetDiameter?: number
  perBoreDepth?: boolean
  perBoreDepthOverrides?: { [loopId: string]: number }
  /** Additional axial travel past each detected bore floor. Applied once and
   * ignored by explicit-depth Smart Height. */
  breakthroughMm?: number
  heightReference?: ChamferHeightReference
  planeOffset?: number
  referencePlaneGeo?: { geoId: string; faceIndex: number; localZ: number }
}

export interface BoreWorkerPayload extends HolderClearanceInputs {
  opId: string
  setupId: string
  params: BoreParams
  heights: HeightParams
  passes: PassParams
  linking: LinkingParams
  tool: Tool
  loops: LoopData[]
  wcsOrigin: { x: number; y: number; z: number }
  feedrateOverride?: FeedrateOverride
  boreBottoms?: { [loopId: string]: number }
}

// ── Thread Mill ─────────────────────────────────────────────────────────────────

/**
 * Thread-milling operation parameters. v1 scope = INTERNAL threads,
 * single-point cutter model (one revolution per pitch), bottom-to-top helix, radial
 * roughing + spring passes, tangent lead-in/out, computer compensation. See ADR-0031.
 */
export interface ThreadMillParams {
  geometryId: string
  loopIds: string[]                              // pre-cleared hole loops (drill-style centroid selection)
  threadKind: 'internal' | 'external'            // v1 focus = internal; external is a follow-up
  externalReference?: 'top' | 'base'             // external-only; 'top' = thread down from boss top (default), 'base' = climb up from base
  majorDiameter: number                          // nominal thread major diameter (mm), e.g. 10 for M10
  pitch: number                                  // mm per revolution; if tpi set, pitch = 25.4 / tpi
  tpi?: number                                   // optional alternate entry (threads per inch)
  handedness: 'right' | 'left'                   // RH default
  cutDirection: 'climb' | 'conventional'         // default climb; drives the direction only while axialDirection is unset
  /** WO-3193: the operator's axial direction. When set, the orbit sense follows
   *  direction x hand x spindle and climb/conventional is what results; unset
   *  (every op saved before WO-3193) derives it from cutDirection as before. */
  axialDirection?: 'bottom-up' | 'top-down'
  roughingPasses: number                        // legacy explicit radial pass count (used only when radialStepover is unset)
  radialStepover?: number                        // max radial bite per infeed pass (mm); drives the pass count when set
  springPasses: number                           // extra passes at final radius (>=0, default 0)
  leadInOut: 'arc' | 'none'                       // tangent lead default 'arc'
  compensation: 'computer'                        // v1 = computer comp only ('control' is a follow-up)
  heightReference?: ChamferHeightReference        // reference plane the thread TOP rides (default geometry_face)
  planeOffset?: number                            // signed offset of the thread top from that reference plane
  /** Datum surface for heightReference 'picked_plane': the operator clicked a model
   *  face; its model-local Z is the reference plane (planeOffset then applies on top).
   *  Distinct from heights.selectedFaceZ (the smart bottom-override) so the two never
   *  collide. Undefined unless heightReference === 'picked_plane'. */
  referencePlaneGeo?: { geoId: string; faceIndex: number; localZ: number }
  threadDepth?: number                            // thread length BELOW the top; store derives bottom = top - threadDepth (mirrors chamfer)
  // Where this op's thread geometry/kind came from (additive, optional; no migration).
  //   'cylinder' = INFERRED from a 3D cylindrical face pick (bore -> internal,
  //                boss -> external; size/depth auto-snapped from the solid).
  //   'loop'     = a bare 2D circle/loop; the user MUST declare kind + direction
  //                + size manually (a flat circle can't distinguish bore vs boss).
  // Absent on legacy/saved files = treated as the manual 'loop' path.
  geometrySource?: 'cylinder' | 'loop'
}

export interface ThreadMillWorkerPayload extends HolderClearanceInputs {
  opId: string
  setupId: string
  params: ThreadMillParams
  heights: HeightParams
  passes: PassParams
  linking: LinkingParams
  tool: Tool
  loops: LoopData[]
  wcsOrigin: { x: number; y: number; z: number }
  feedrateOverride?: FeedrateOverride
}

// ── Worker protocol ───────────────────────────────────────────────────────────

// ── Chamfer 2D ────────────────────────────────────────────────────────────────

// Reference plane an op's cut top/bottom sits on (+ a planeOffset). Resolved to
// a WCS-relative Z at dispatch (resolveTopZ). The UI now offers the consolidated
// set: geometry_face ("Geometry" - the geometry's current/projected plane),
// stock_top, stock_bottom, machine_floor (the table, machine Z=0), wcs_plane,
// and selected_face ("Model face..." - Phase 2 flyout pick). 'absolute' and
// 'model_top' are retained ONLY for backward compatibility with projects saved
// before the consolidation; they are no longer offered in the dropdowns.
export type ChamferHeightReference =
  | 'geometry_face' | 'stock_top' | 'stock_bottom' | 'machine_floor'
  | 'wcs_plane' | 'selected_face' | 'absolute' | 'model_top'
  // 'picked_plane' = MANUAL datum: the operator clicks a model face and its
  // model-local Z becomes the reference plane (planeOffset applies on top).
  // Distinct from 'selected_face' (the smart B-rep bottom-override). The picked
  // surface rides on each op's params.referencePlaneGeo.
  | 'picked_plane'

// Coordinate-hierarchy canonical name for the reference-plane enum.
// `ChamferHeightReference` is the LEGACY name (it is op-agnostic in practice —
// every op resolves its top/bottom against the same set). The full rename +
// reader migration is deferred to Phase 2; this alias lets Phase 0+ code refer
// to the concept by its hierarchy name without touching existing references.
export type CoordinateReference = ChamferHeightReference

export interface ChamferParams {
  /** Absent retains authored Linking entry. This policy is Chamfer-only. */
  entryPolicy?: 'authored' | 'clear_space'
  geometryId: string
  loopIds: string[]
  /** Per-loop chamfer side — 'outer' offsets the path outward (outside profile),
   *  'inner' offsets inward (inside profile / inside of a pocket wall).
   *  Falls back to 'outer' for any loop not in this map. */
  loopSides: Record<string, 'outer' | 'inner'>
  /** WO-3021: a loop listed here is cut only over these arc-length intervals
   *  [start, end] (mm along the loop's own point order from points[0]; end may
   *  pass the loop's length and wrap), each as an open pass. A chamfer modeled
   *  along part of a loop machines that part, never the loop's other edges.
   *  Absent (every older op): every selected loop is cut all the way round. */
  loopExtents?: Record<string, Array<[number, number]>>
  direction: 'climb' | 'conventional'
  /** Z depth of the chamfer cut below the reference face (mm). Equal to zDrop when tipOffset = 0. */
  chamferWidth: number
  /** Extra Z depth added beyond chamferWidth (mm). Moves contact point up the flute for better
   *  surface speed. XY path shift = tipOffset × tan(angleFromAxisDeg). */
  tipOffset: number
  overlapMm: number
  /** Which plane the chamfer edge sits on. The store resolves this to a WCS Z
   *  before dispatching to the worker, overriding heights.topHeight. */
  heightReference: ChamferHeightReference
  /** For stock_top/stock_bottom/wcs_plane: fine-tune Z offset from the reference (mm).
   *  For 'absolute': this IS the WCS Z value. */
  planeOffset: number
  /** Datum surface for heightReference 'picked_plane': the operator clicked a model
   *  face; its model-local Z is the reference plane (planeOffset then applies on top).
   *  Distinct from heights.selectedFaceZ (the smart bottom-override) so the two never
   *  collide. Undefined unless heightReference === 'picked_plane'. */
  referencePlaneGeo?: { geoId: string; faceIndex: number; localZ: number }
}

export interface ChamferEntryEvidence {
  readonly frame: 'world' | 'unknown' | 'mismatched'
  /** These are retained-material envelopes, never exact physical-stock certificates. */
  readonly stockSource: 'prior-result-envelope' | 'loaded-stock-envelope' | 'unavailable'
  readonly dispatch: { readonly opId: string; readonly setupId: string }
  readonly workholding: { readonly complete: boolean; readonly omissions: readonly {
    readonly instanceId: string; readonly geometryId?: string; readonly componentId?: string; readonly reason: string
  }[] }
}

export interface ChamferWorkerPayload extends HolderClearanceInputs {
  entryEvidence?: ChamferEntryEvidence
  /** Actual predecessor provenance; sampled remainingStock is never whole-cell proof. */
  clearSpacePredecessors?: readonly import('./holderClearance').ClearSpacePredecessor[]
  remainingStock?: import('./stockState').StockState
  clearancePart?: import('./holderClearance').ClearanceMesh
  workholding?: readonly import('./holderClearance').ClearanceMesh[]
  opId: string
  setupId: string
  params: ChamferParams
  heights: HeightParams
  passes: PassParams
  linking: LinkingParams
  tool: Tool
  loops: LoopData[]
  wcsOrigin: { x: number; y: number; z: number }
  feedrateOverride?: FeedrateOverride
}

// ── Adaptive Clearing 2D ───────────────────────────────────────────────────────

export interface ACParams {
  geometryId: string
  loopIds: string[]
  /** Boundary source (mirrors pocket/facing). Absent === 'geometry' (today's
   *  behavior + default), so existing AC ops are byte-identical until the user
   *  picks Stock. 'stock' clears the whole stock footprint and auto-islands
   *  standing bosses (resolved in the store dispatch, same as pocket). */
  boundarySource?: PocketBoundarySource
  // ── LEGACY bespoke-planner fields ──────────────────────────────────────────
  // Inputs of the RETIRED pre-FreeCAD-port planner. The live engine (engine/)
  // ignores every field in this block except `climb`, which is reused as its
  // travel-handedness control. The others stay typed, at
  // inert modal defaults, only so existing ACParams payloads and saved projects
  // keep their shape. Do not present the remaining members as working knobs.
  /** LEGACY (ignored by the live engine): ideal angular engagement (radians). */
  targetEngagement: number
  /** LEGACY (ignored by the live engine): hard engagement cap (radians). */
  maxEngagement: number
  /** LEGACY (ignored by the live engine): per-step advance distance (mm). */
  stepDistance: number
  /** LEGACY (ignored by the live engine): max heading change per step (radians). */
  thetaMax: number
  /** Legacy Adaptive Clearing direction compatibility bit. The retired planner
   *  persisted `true` while the live engine's historical canonical-forward stream
   *  is physically conventional for a pocket boundary. Never interpret this field
   *  directly; use resolveAdaptiveMillingDirection() and
   *  encodeAdaptiveMillingDirection(). */
  climb: boolean
  /** Helix entry ramp angle (degrees). Engine-consumed (falls back to
   *  LinkingParams.rampAngle, then 3). */
  rampAngle: number
  /** LEGACY (ignored by the live engine): min uncut area (mm²) completion gate. */
  completionTolerance: number
  // ── FreeCAD-port engine entry/geometry (user-settable; engine applies defaults) ──
  /** Entry helix diameter as a percentage of tool diameter (mirrors PocketParams).
   *  The engine bores this helix into fresh material; below the minimum that fits a
   *  pocket it falls back to a straight plunge. Default 90 (%). */
  helixDiameter?: number
  /** Minimum accepted entry-helix radius (mm). A planned helix below this floor
   *  falls back to a straight plunge. Missing, non-finite, or non-positive values
   *  use the historical 0.2 mm floor. */
  minHelixRadius?: number
  /** Geometric tolerance (mm) for the adaptive engine: clipper offset arc tolerance,
   *  cleaned-polyline collinear-merge tolerance, and the adaptive step floor. Smaller =
   *  finer geometry + slower compute. Default 0.02. */
  tolerance?: number
  /** Integral wall-follow: when a between-pass LIFT (retract+rapid+plunge) connects two
   *  points that lie on the SAME machinable-region boundary loop within a length budget,
   *  ride the wall at depth instead of lifting. Eliminates risky retract+reposition+plunge
   *  cycles. Default OFF (false) = byte-identical to the lift-everywhere behavior. */
  integralWallFollow?: boolean
  /** Maximum direct integral wall-follow length as a multiple of the straight endpoint
   *  distance. Missing, non-finite, or non-positive values use the historical 2.0 budget. */
  integralWallFollowLengthFactor?: number
  /** Wall cleanup as we go (integrated finishing): at an inter-pass transition where BOTH
   *  the prior cut's end and the next cut's start lie on the machinable-region wall, replace
   *  the link with a wall-follow EXIT (ride the wall behind the cut) -> tangent loopback
   *  fillet -> fast-traverse over cleared stock -> tangent fillet -> wall-follow ENTRY into
   *  the next pass. Cleans the wall sliver every transition so the separate finishing-contour
   *  pass is skipped. Distinct from integralWallFollow (which only converts a lift) and the
   *  legacy wallFollowEnabled finishing pass. Default OFF (false) = no change to behavior. */
  wallCleanupAsWeGo?: boolean
  /** Loopback fillet radius as percent of tool radius (default 25). */
  loopbackFilletPct?: number
  /** When true, replay the adaptive cut/link/entry stream once at the true bottom
   *  after roughing stops above it by PassParams.floorStockToLeave. With zero axial
   *  stock this is a one-time spring/cleanup replay. Default OFF (false). */
  floorFinish?: boolean
  /** When true, emit a dedicated wall-finishing pass that rides the machinable-region
   *  walls at the finished offset. Distinct from wallCleanupAsWeGo (between-pass skims)
   *  and the legacy wallFollowEnabled contour. Default OFF (false). */
  wallFinish?: boolean
  /** Where the wall-finish pass runs, AND what it leaves on the wall:
   *   - 'final'         = once after all roughing, at full depth. LEAVES the radial
   *                       PassParams.stockToLeave standing (WO-450).
   *   - 'each_stepdown' = a lap after every depth level. Also LEAVES the stock standing.
   *   - 'final_to_size' = WO-1043, the Contour `rough_finish_final` meaning: rough with
   *                       stock to leave at EVERY stepdown including the last, then ONE
   *                       lap at the final depth that CUTS TO SIZE -- a full-depth wall
   *                       in a single pass. Same depth SCHEDULE as 'final'; the only
   *                       difference is that its lap rides the true wall.
   *  Default 'final'. 'final_to_size' is the user-facing spelling of the WO-450
   *  wallFinishToNet geometry, scheduled at the bottom level only; index.ts turns it
   *  into exactly that ProcessParams flag rather than adding a second geometry path. */
  wallFinishMode?: 'final' | 'each_stepdown' | 'final_to_size'
  /** WO-450 escape hatch. When TRUE the wall-finish pass rides the TRUE wall at toolRadius
   *  and cuts to net, treating PassParams.stockToLeave as roughing-only -- the pre-WO-450
   *  shape, restored term for term, for the operator who wants the finish lap to go to size
   *  in one op. Default FALSE (absent): the lap stops stockToLeave off the wall and leaves
   *  the radial stock the operation asked for. NOT wallFinishMode, which is a depth SCHEDULE
   *  and means something else. Internal name only: since WO-1043 the user-facing spelling
   *  is wallFinishMode 'final_to_size' ("Finish pass at final depth (cuts to size)"), which
   *  index.ts resolves INTO this flag. An explicit wallFinishToNet still wins, so a project
   *  file that set it keeps meaning what it meant. */
  wallFinishToNet?: boolean
  /** Which plane the bottom of cut sits on. Resolved to bottomHeight (WCS)
   *  before dispatch (mirrors PocketParams). Absent (older projects) → the op
   *  falls back to bottomHeightMode/absolute resolution (no behavior change). */
  heightReference?: ChamferHeightReference
  /** Fine-tune offset from the reference plane (mm). Positive = above, negative = below. */
  planeOffset?: number
  /** Datum surface for heightReference 'picked_plane': the operator clicked a model
   *  face; its model-local Z is the reference plane (planeOffset then applies on top).
   *  Distinct from heights.selectedFaceZ (the smart bottom-override) so the two never
   *  collide. Undefined unless heightReference === 'picked_plane'. */
  referencePlaneGeo?: { geoId: string; faceIndex: number; localZ: number }
}

export type AdaptiveMillingDirection = 'climb' | 'conventional'

/**
 * Translate the persisted ACParams.climb compatibility bit into physical milling
 * direction for the clockwise-spindle convention used by the other 2D operations.
 *
 * Missing/true preserves the byte-stable historical canonical-forward stream. On
 * an Adaptive pocket outer boundary that stream keeps cleared space on the left and
 * material on the right, so it is conventional. false selects the reversed,
 * material-left climb stream added later.
 */
export function resolveAdaptiveMillingDirection(
  legacyClimb: boolean | undefined,
): AdaptiveMillingDirection {
  return legacyClimb === false ? 'climb' : 'conventional'
}

/** Encode a physical direction back into the persisted compatibility bit. */
export function encodeAdaptiveMillingDirection(
  direction: AdaptiveMillingDirection,
): boolean {
  return direction === 'conventional'
}

export interface ACWorkerPayload extends HolderClearanceInputs {
  opId: string
  setupId: string
  params: ACParams
  heights: HeightParams
  passes: PassParams
  linking: LinkingParams
  tool: Tool
  loops: LoopData[]
  /** Authored XY placement for each source loop. The adaptive engine uses the
   *  selected boundary's placement as the feature-local planning origin. Older
   *  direct-engine callers omit this and retain the historical zero origin. */
  loopOrigins?: Record<string, { x: number; y: number }>
  wcsOrigin: { x: number; y: number; z: number }
  /** Dispatch-time project machine G0 rate (mm/min), also the execution resolver's
   *  fast-traverse default/ceiling. Optional for historical direct-engine callers. */
  machineRapidRate?: number
  feedrateOverride?: FeedrateOverride
}

// ── Face 2D ────────────────────────────────────────────────────────────────────
// Full configuration surface per ADR 0015. v1 implements a subset; deferred
// members are typed here, shown greyed in the UI, and fail loud (ADR 0003) if a
// project arrives with them set to an unimplemented value. Stepover/stepdown/
// finishPasses ride on the shared PassParams; radial stock-to-leave is
// PassParams.stockToLeave.

/** Where the face region polygon comes from (ADR 0015 §1). All three are
 *  resolved in the store. 'rest' (WO-1820 v1) = the stock/contour boundary minus
 *  the footprints of the EARLIER enabled pocket operations in the same setup,
 *  so a face after a pocket does not re-cut what the pocket already removed.
 *  The removed footprints arrive at the builder as FaceWorkerPayload.regionHoles;
 *  the builder itself stays source-agnostic and never learns which source ran. */
export type FaceBoundarySource = 'stock' | 'geometry' | 'rest'

/** Fill pattern. 'linear' / 'zigzag' / 'one_way' = straight parallel passes;
 *  'offset' = concentric contour-parallel rings (closed loops + stepover links). */
export type FacePattern = 'linear' | 'zigzag' | 'one_way' | 'offset' | 'spiral'

/** How far the tool may cross the region boundary. 'outside' overruns fully
 *  (default for facing — ADR 0015 §2); 'center' stops the tool centre at the
 *  edge; 'inside' keeps the whole tool inside the region. */
export type FaceBoundaryContainment = 'inside' | 'center' | 'outside'

/** How consecutive passes are linked. v1 implements 'straight' and 'smooth'. */
export type FaceTransition = 'straight' | 'smooth' | 'high_feed' | 'no_contact'

export interface FaceParams {
  // ── Boundary (ADR 0015 §1) ──
  boundarySource: FaceBoundarySource
  geometryId: string            // used when boundarySource === 'geometry' (deferred)
  loopIds: string[]             // used when boundarySource === 'geometry' (deferred)
  /** Grow (+) or shrink (−) the region before the tool offset (mm). */
  stockOffset: number
  /** How far the tool may cross the boundary edge. Default 'outside'. */
  boundaryContainment: FaceBoundaryContainment
  /** Loops to keep clear (islands/features). DEFERRED — fail loud if non-empty. */
  avoidanceLoopIds: string[]

  // ── Pattern ──
  pattern: FacePattern
  /** Pass direction in degrees; 0 = +X. */
  passAngle: number
  direction: 'climb' | 'conventional' | 'both_ways'
  /** Start passes from the opposite side of the region. */
  fromOtherSide: boolean
  /** Overrun distance past each pass end (mm). */
  passExtension: number
  /** DEFERRED — chip-thinning loops at pass entry. */
  chipThinning: boolean

  // ── Depth (stepdown/stepover live on PassParams) ──
  /** Alternate pass direction between successive Z levels. */
  bothSidesPerLevel: boolean
  /** Axial stock left on the faced floor (mm). */
  floorStockToLeave: number
  /** Extra pass at final depth (own feed via the feedrate resolver). */
  finishPass: boolean

  // ── Heights ──
  /** Which plane the top of cut sits on; store resolves to topHeight (WCS)
   *  before dispatch. Reuses the chamfer/pocket reference enum. */
  heightReference?: ChamferHeightReference
  planeOffset?: number
  /** Datum surface for heightReference 'picked_plane': the operator clicked a model
   *  face; its model-local Z is the reference plane (planeOffset then applies on top).
   *  Distinct from heights.selectedFaceZ (the smart bottom-override) so the two never
   *  collide. Undefined unless heightReference === 'picked_plane'. */
  referencePlaneGeo?: { geoId: string; faceIndex: number; localZ: number }
  /** Smart Height V2 finished-face binding. This is deliberately separate from
   *  referencePlaneGeo (legacy/top-of-cut datum) and heights.selectedFaceZ
   *  (source-implicit V1 bottom). A Face target must retain the geometry and
   *  subshape that supplied its physical endpoint so preview and regeneration
   *  can rebuild evidence after placements or model revisions change. */
  targetPlaneGeo?: { geoId: string; faceIndex: number; localZ: number }

  // ── Linking ──
  entryType: 'plunge' | 'lead_in_arc'
  /** Vertical lead-in arc radius (mm). DEFERRED — only when entryType='lead_in_arc'. */
  leadInRadius: number
  /** Lead-out arc radius (mm). DEFERRED. */
  leadOutRadius: number
  /** Stay down between passes within maxStayDownDistance instead of retracting. */
  keepToolDown: boolean
  /** Max distance for keepToolDown (mm); beyond it, retract to retractZ. */
  maxStayDownDistance: number
  /** Extend the path so the tool fully exits material before retracting. */
  extendBeforeRetract: boolean
  transition: FaceTransition

  /** Chord tolerance for curve approximation (mm). */
  tolerance: number
}

export interface FaceWorkerPayload extends HolderClearanceInputs {
  opId: string
  setupId: string
  params: FaceParams
  heights: HeightParams
  passes: PassParams
  linking: LinkingParams
  tool: Tool
  loops: LoopData[]
  /** Keep-out islands INSIDE the faced region, as world-XY closed loops
   *  (WO-1820). Absent for every boundary source but 'rest', and its absence is
   *  what keeps the single-boundary fill byte-identical: with no holes the
   *  builder takes the largest closed loop exactly as before. When present,
   *  `loops` carries EVERY outer region of the rest boundary (the difference can
   *  split the stock into several islands) and these are the holes punched
   *  through them. Each hole is grown into by the same tool offset the outer
   *  edge is grown by, so the cutter clears right up to the pocket wall. */
  regionHoles?: Array<Array<{ x: number; y: number }>>
  wcsOrigin: { x: number; y: number; z: number }
  feedrateOverride?: FeedrateOverride
}

/** Trace = ride/offset a path with any tool; Engrave = V/chamfer bit, depth
 *  optionally derived from a target line width via the tool tip angle. The
 *  toolpath core is identical; mode drives UI helpers and defaults. */
export type EngraveMode = 'trace' | 'engrave'

/** Where the tool centre runs relative to the source curve. 'center' rides the
 *  line; 'left'/'right' offset by sideOffset (compensation is always "in
 *  computer" — we emit the offset path, never G41/G42). */
export type EngraveSide = 'center' | 'left' | 'right'

export interface EngraveParams {
  // ── Geometry ──
  geometryId: string
  loopIds: string[]
  /** Trace open curves (lines, arcs, open polylines, text outlines). */
  includeOpen: boolean
  /** Trace closed loops too — ride directly on the line (no inside/outside offset). */
  includeClosed: boolean

  // ── Mode + depth model ──
  mode: EngraveMode
  /** Constant-depth (flat-bottom) for now. 'vcarve' (variable medial-axis depth)
   *  is a reserved future value — see the deferred OperationType 'vcarve'. */
  depthModel: 'constant'

  // ── Path positioning ──
  side: EngraveSide
  /** Sideways offset distance (mm) when side !== 'center'. */
  sideOffset: number
  /** Z shift applied to the cut plane (mm). Negative drives a V/chamfer tip into
   *  the surface (uses an axial surface offset). */
  axialOffset: number

  // ── V-engrave helper (mode === 'engrave' + V/chamfer bit) ──
  /** Desired groove width at the surface (mm). */
  targetLineWidth: number
  /** When true, Smart Height V2 derives depth from targetLineWidth and the
   *  selected tool's half-angle, tip-flat diameter, diameter, and flute length.
   *  Frozen V1 operations retain the historical ideal-point calculation. */
  useWidthForDepth: boolean

  // ── Travel ──
  /** 'as_drawn' keeps the source point order (default for open curves);
   *  'climb'/'conventional' set winding on closed loops. */
  direction: 'climb' | 'conventional' | 'as_drawn'

  // ── Heights ──
  /** Which plane the engrave top sits on; the store resolves this to topHeight
   *  (WCS) before dispatch. Reuses the chamfer/face reference enum. */
  heightReference?: ChamferHeightReference
  planeOffset?: number
  /** Datum surface for heightReference 'picked_plane': the operator clicked a model
   *  face; its model-local Z is the reference plane (planeOffset then applies on top).
   *  Distinct from heights.selectedFaceZ (the smart bottom-override) so the two never
   *  collide. Undefined unless heightReference === 'picked_plane'. */
  referencePlaneGeo?: { geoId: string; faceIndex: number; localZ: number }

  /** Chord tolerance for arc/offset approximation (mm). */
  tolerance: number

  // ── Style (WO-2299) ──
  /** How a Trace on the line (mode 'trace', side 'center') cuts. 'plain'
   *  (default) is one pass along the curve; 'trochoidal' cuts a slot
   *  `trochoidalWidth` wide centred on the curve in overlapping orbits that
   *  advance `trochoidalAdvance` per orbit. Absent resolves to 'plain'
   *  (byte-identical legacy output). */
  engraveStyle?: EngraveStyle
  /** Trochoidal slot width (mm). Absent follows the tool: 1.5 x its diameter. */
  trochoidalWidth?: number
  /** Trochoidal centre advance per orbit (mm). Absent follows the tool: 0.1 x its diameter. */
  trochoidalAdvance?: number
}

/** WO-2299: the Engrave Style choices. */
export type EngraveStyle = 'plain' | 'trochoidal'
export const ENGRAVE_STYLE_LABELS: Record<EngraveStyle, string> = {
  plain: 'Plain',
  trochoidal: 'Trochoidal',
}

export interface EngraveWorkerPayload extends HolderClearanceInputs {
  opId: string
  setupId: string
  params: EngraveParams
  heights: HeightParams
  passes: PassParams
  linking: LinkingParams
  tool: Tool
  loops: LoopData[]
  wcsOrigin: { x: number; y: number; z: number }
  feedrateOverride?: FeedrateOverride
}

// ── Pattern (WO-3001, WO-2962 PLAN Phase B) ─────────────────────────────────
//
// A scripted decorative pattern: the operation carries a data-only PatternSpec
// (src/lib/cam/pattern2d/types.ts) and the toolpath worker hands it to
// buildPatternToolpath. Tool, heights, feeds and spindle come from the
// operation exactly as for Face/Engrave. The region is optional: geometryId ''
// means no region (the spec's anchor must then be 'wcs-origin' or a point).

export type { PatternSpec, PatternWorkerPayload, PatternMachineLimits } from './pattern2d/types'

export interface PatternParams {
  /** Region source, as for every 2.5D family. '' = no region. */
  geometryId: string
  /** Closed loops of that geometry forming the region (even-odd); empty = every
   *  closed loop of the source. Open loops are never a region. */
  loopIds: string[]
  /** The pattern itself, stored verbatim and validated by parsePatternSpec at
   *  compute (a spec it cannot read is refused there, by name). */
  spec: unknown
}

export interface PatternOperationWorkerPayload extends HolderClearanceInputs {
  opId: string
  setupId: string
  params: PatternParams
  heights: HeightParams
  passes: PassParams
  linking: LinkingParams
  tool: Tool
  loops: LoopData[]
  wcsOrigin: { x: number; y: number; z: number }
  feedrateOverride?: FeedrateOverride
  /** The spindle speed the post will command, for the C7 note. */
  spindleRpm?: number
  /** Machine bounds the pattern is reported against (C6, C7). */
  machine?: PatternMachineLimits
}

// ── V-Carve (WO-1174) ────────────────────────────────────────────────────────
//
// Variable-depth carving along the medial axis of closed outlines with a V-bit
// (src/lib/cam/vcarve2d/). Depth at every point of the ridge is
// (inscribed radius - tip radius) / tan(half angle), clipped at the flat depth.
// The same family carries a second role, 'flat_clearing': a self-sufficient
// sibling operation that pockets the flat floors with a separate end mill
// before the V-bit runs. `geometryId` stays the 2.5D geometry entry (see
// opGeometryFieldContract.ts).

export type VCarveRole = 'carve' | 'flat_clearing'

/** How the floors of flat-depth areas get cleared.
 *  'vbit'  the V-bit itself rings the floor (default; scalloped by the tip);
 *  'tool'  a separate end mill (its own operation) clears, the V-bit finishes
 *          the corners that tool cannot reach;
 *  'none'  floors are left for an operation of the user's own. */
export type VCarveFlatClearingMode = 'vbit' | 'tool' | 'none'

export interface VCarveFlatClearing {
  mode: VCarveFlatClearingMode
  /** Diameter (mm) of the separate clearing tool. Recorded on the carve
   *  operation so the V-bit knows what that tool leaves behind. */
  clearingToolDiameter?: number
  /** Ring stepover (mm) for floor clearing with the V-bit. */
  stepoverMm: number
}

export interface VCarveParams {
  geometryId: string
  /** Closed loops to carve; empty = every closed loop of the geometry. */
  loopIds: string[]
  role: VCarveRole
  /** Maximum depth below Material Start (mm). Undefined = the bit's own
   *  physical limit (full diameter reached, or flute length). */
  flatDepthMm?: number
  /** Carving begins this far below the datum surface (mm), for carving
   *  inside an existing pocket or an inlay plug. */
  startDepthMm: number
  /** Signed offset of the outlines before carving (mm); positive grows the
   *  carved area. Used for inlay fits. */
  allowanceMm: number
  flatClearing: VCarveFlatClearing
  /** role 'flat_clearing' only: the V-bit that will follow, whose half angle
   *  and tip flat define where the floor is flat. */
  vbit?: { angleFromAxisDeg: number; tipDiameter: number }
  /** Boundary sampling / chord tolerance (mm). */
  tolerance: number
  heightReference?: ChamferHeightReference
  planeOffset?: number
  referencePlaneGeo?: { geoId: string; faceIndex: number; localZ: number }
}

export interface VCarveWorkerPayload extends HolderClearanceInputs {
  opId: string
  setupId: string
  params: VCarveParams
  heights: HeightParams
  passes: PassParams
  linking: LinkingParams
  tool: Tool
  loops: LoopData[]
  wcsOrigin: { x: number; y: number; z: number }
  feedrateOverride?: FeedrateOverride
}

// ── Nesting ─────────────────────────────────────────────────────────────────
// The nest pack/solve can run ~15s on a dense sheet, so it runs OFF the main
// thread on the SAME worker transport as toolpaths (mirrors the COMPUTE_* shape).
// The store resolves each source geometry's loops into a NestPart (outer =
// largest closed loop, holes = the rest) BEFORE dispatch; the worker calls the
// engine's runNest seam and posts the placements/unplaced/utilization back. The
// `nestId` field keys the response back to the NestRecord (analogous to opId).

export interface NestWorkerPayload {
  /** Keys the NEST_* response back to the store's pending NestRecord. */
  nestId: string
  /** Source parts resolved to engine shape (loops already in part-local 2D). */
  parts: { part: NestPart; quantity: number }[]
  sheet: { width: number; height: number }
  style: NestStyle
  spacing: Spacing
  solver: SolverMode
  seed: number
  rotationCount?: number
  timeBudgetMs?: number
  curveTolerance?: number
}

export type WorkerRequestMsg =
  | { type: 'COMPUTE_CONTOUR';             payload: ContourWorkerPayload  }
  | { type: 'COMPUTE_POCKET';              payload: PocketWorkerPayload   }
  | { type: 'COMPUTE_DRILL';               payload: DrillWorkerPayload    }
  | { type: 'COMPUTE_BORE';                payload: BoreWorkerPayload     }
  | { type: 'COMPUTE_THREAD_MILL';          payload: ThreadMillWorkerPayload }
  | { type: 'COMPUTE_CHAMFER';             payload: ChamferWorkerPayload  }
  | { type: 'COMPUTE_FACE';                payload: FaceWorkerPayload     }
  | { type: 'COMPUTE_ENGRAVE';             payload: EngraveWorkerPayload  }
  | { type: 'COMPUTE_VCARVE';              payload: VCarveWorkerPayload   }
  | { type: 'COMPUTE_ADAPTIVE_CLEARING';   payload: ACWorkerPayload       }
  | { type: 'COMPUTE_PATTERN';             payload: PatternOperationWorkerPayload }
  | { type: 'COMPUTE_NEST';                payload: NestWorkerPayload     }

export type WorkerResponseMsg =
  | { type: 'TOOLPATH_COMPLETE'; opId: string; moves: ToolpathMove[]; computeTimeMs: number }
  | { type: 'TOOLPATH_ERROR';    opId: string; message: string }
  | { type: 'TOOLPATH_PROGRESS'; opId: string; progress: number /* 0..1 */; phase?: string }
  | { type: 'NEST_COMPLETE'; nestId: string; placements: Placement[]; unplaced: { partId: string; count: number }[]; utilization: number; sheetUsed: { width: number; height: number }; computeTimeMs: number }
  | { type: 'NEST_ERROR';    nestId: string; message: string }

export interface ContourWorkerPayload extends HolderClearanceInputs {
  opId: string
  setupId: string
  params: ContourParams
  heights: HeightParams
  passes: PassParams
  linking: LinkingParams
  tool: Tool
  loops: LoopData[]
  wcsOrigin: { x: number; y: number; z: number }
  feedrateOverride?: FeedrateOverride
  /** Stock-bottom Z in the same WCS-relative frame as heights.bottomHeight.
   *  Required only when holding tabs are enabled, so disabled/legacy dispatch
   *  remains byte-compatible. */
  stockBottomZ?: number
  /** Optional per-loop bottom-of-cut Z (WCS-relative), keyed by loop id. When a loop
   *  id is present, that loop's profile descends to its own Z instead of the op-wide
   *  bottom - so multiple picked features at different heights each cut to their own
   *  level. Absent/empty => every loop uses the shared op bottom (byte-identical legacy
   *  path). Mirrors DrillWorkerPayload.holeBottoms. */
  loopBottoms?: { [loopId: string]: number }
  /** Active stock world-XY bounds. Attached only for open contours, whose
   *  tangent leads must start/end with the whole cutter outside the stock. */
  stockBounds?: {
    min: { x: number; y: number }
    max: { x: number; y: number }
  }
}

export interface PocketWorkerPayload extends HolderClearanceInputs {
  opId: string
  setupId: string
  params: PocketParams
  heights: HeightParams
  passes: PassParams
  linking: LinkingParams
  tool: Tool
  loops: LoopData[]
  wcsOrigin: { x: number; y: number; z: number }
  feedrateOverride?: FeedrateOverride
}

export interface LoopData {
  id: string
  /** The loop's saved operator name (Loop2D.name) - what the operation's
   *  Geometry list shows. Message text only; identity stays `id`. */
  name?: string
  points: Array<{ x: number; y: number }>
  closed: boolean
  type: string
}
