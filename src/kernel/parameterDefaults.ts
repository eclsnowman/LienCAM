// WO-2905: UI-independent authoring defaults. Values moved without retuning.
import type { Adaptive3dParams, Parallel3dParams, WaterlineParams, SteepShallow3dParams, Scallop3dParams, Pencil3dParams, Rest3dParams, RestMachiningSettings } from './parameterTypes'
import type { HeightParams, PassParams, LinkingParams, OperationType } from '../types'
import type {
  ContourParams, PocketParams, DrillParams, BoreParams, ChamferParams, VCarveParams,
  FaceParams, EngraveParams, ACParams, ThreadMillParams, PatternParams,
} from '../lib/cam/types'
import { DEFAULT_CONTOUR_TABS } from '../lib/cam/types'
import { defaultHeightIntent } from '../lib/cam/heightIntent'

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
  entryPolicy: 'authored',
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

export const DEFAULT_PARALLEL3D_PARAMS: Parallel3dParams = {
  stepover: 1,
  angleDeg: 0,
  tolerance: 0.05,
  surfaceStockToLeave: 0,
  maxSlopeDeg: undefined,
  finishDepth: undefined,
  useStockBoundary: false,
  stockEdgeOvershoot: undefined, // undefined -> auto (tool radius)
}

export const DEFAULT_STEEP_SHALLOW3D_PARAMS: SteepShallow3dParams = {
  thresholdDeg: 30,
  stepdown: 1,
  stepover: 1,
  angleDeg: 0,
  tolerance: 0.05,
  stockToLeave: 0,
  useStockBoundary: false,
  finishDepth: undefined,
}

export const DEFAULT_SCALLOP3D_PARAMS: Scallop3dParams = {
  // 0.02 mm, not the 0.01 this shipped with (architect decision 2026-09-04).
  // Stepover goes as sqrt(scallop), so 0.01 -> 0.02 is roughly half the passes
  // and half the cycle time - measured at ~15 min on Operator's test plate at 0.01.
  // 0.02 mm of cusp is below what a finish pass leaves visible on this class of
  // machine, and anyone who wants a mirror can type 0.01 in the field. A
  // default nobody would sit through is worse than one they occasionally lower.
  scallopHeight: 0.02,
  tolerance: 0.05,
  stockToLeave: 0,
  useStockBoundary: false,
  finishDepth: undefined,
  direction: 'climb',
  stockEdgeOvershoot: undefined, // undefined -> auto (tool radius)
}

export const DEFAULT_PENCIL3D_PARAMS: Pencil3dParams = {
  tolerance: 0.05, stockToLeave: 0, useStockBoundary: false,
  finishDepth: undefined, direction: 'climb',
}

export const DEFAULT_WATERLINE_PARAMS: WaterlineParams = {
  stepdown: 1,
  tolerance: 0.05,
  stockToLeave: 0,
  minSlopeDeg: 0,
  flatAreaDetection: true,
  // Region by region: each wall, boss or bore is
  // finished to its bottom with stay-down links before the next one starts.
  // Level by level hops between regions at every level and retracts on each
  // hop - measured on Operator's five-bore plate as a retract per bore per level
  // (WO-1176 in-app capture), the "too many retracts" complaint every forum
  // has about waterlines. Both stay available; this is the one that starts.
  order: 'region',
  direction: 'climb',
  finishDepth: undefined,
  useStockBoundary: false,
  stockEdgeOvershoot: undefined,
}

export const DEFAULT_ADAPTIVE3D_PARAMS: Adaptive3dParams = {
  maxStepdown: 3,
  stepover: 0.4,
  millingDirection: 'climb',
  intermediateStepdown: false,
  wallLeadInRadius: 0,
  wallLeadOutRadius: 0,
  loopbackFilletPct: 25,
  integralWallFollow: true,
  integralWallFollowLengthFactor: 2,
  tolerance: 0.05,
  helixDiameter: 3,
  helixAngleDeg: 10,
  radialStockToLeave: 0,
  axialStockToLeave: 0,
  cellSize: 0, // 0 -> auto (deriveCellSize)
  useStockBoundary: false,
  stockEdgeOvershoot: undefined, // undefined -> auto (tool radius, full-clear only)
}

export const DEFAULT_REST3D_PARAMS: Rest3dParams = {
  // Engine-level compatibility default. Newly-authored operation settings
  // always persist the UI default (`previous_operations`) explicitly.
  stockSource: 'previous_tool',
  referenceToolDiameter: 12,
  referenceCornerRadius: 0,
  tolerance: 0.2,
  stockToLeave: 0,
  stepdown: 3,
  useStockBoundary: false,
  direction: 'climb',
};

export const DEFAULT_REST_MACHINING_SETTINGS: RestMachiningSettings = {
  restMachining: false,
  stockSource: 'previous_operations',
};

/** WO-3001: the PLAN sec. 6 rose spiral (the preset's own defaults) at the WCS
 *  origin, 0.15 mm deep, so a pattern needs no region to compute. */
export const defaultPatternParams: PatternParams = {
  geometryId: '', loopIds: [],
  spec: {
    version: 1, units: 'mm', anchor: 'wcs-origin',
    curves: [{ kind: 'preset', name: 'rose-spiral', params: {} }],
    depth: 0.15,
  },
}

export const parameterDefaults = {
  contour_2d: defaultContourParams,
  pocket_2d: defaultPocketParams,
  drill: defaultDrillParams,
  bore: defaultBoreParams,
  chamfer: defaultChamferParams,
  face: defaultFaceParams,
  engrave: defaultEngraveParams,
  vcarve: defaultVCarveParams,
  adaptive_clearing_2d: defaultACParams,
  thread_mill: defaultThreadMillParams,
  pattern: defaultPatternParams,
  parallel_3d: DEFAULT_PARALLEL3D_PARAMS,
  steep_shallow_3d: DEFAULT_STEEP_SHALLOW3D_PARAMS,
  scallop_3d: DEFAULT_SCALLOP3D_PARAMS,
  pencil_3d: DEFAULT_PENCIL3D_PARAMS,
  waterline_3d: DEFAULT_WATERLINE_PARAMS,
  adaptive_3d: DEFAULT_ADAPTIVE3D_PARAMS,
} satisfies Record<OperationType, object>
