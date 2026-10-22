// WO-3018 (alpha.3 A3-27 step 2, REQ-OP-adaptive-2): the adaptive engine's numeric policy.
//
// Every number src/lib/cam/adaptiveClearing2d/engine/ reads for sampling, steering,
// sharpening and caps lives here, once, with the file:line it came from on the WO-3018
// starter (855ea4d9). The engine reads these values and holds no copy of them. Values are
// UNCHANGED from that commit: a later order moves a number only behind its own
// before/after card. One record serves both registry aliases (adaptive_clearing_2d and
// adaptive_3d), because the 3D rougher clears each level through the same engine.
//
// Not listed on purpose (they are numerics, not policy): geometric epsilons and float
// slack (1e-3 mm and below), polygon validity guards (< 3 or < 4 vertices), unit
// conversions, progress-bar fractions, hash multipliers, the Clipper precision and miter
// arguments, bisection and probe budgets, the landing-lead and detour search ladders and
// candidate budgets (linking, a later services order), and operator-message formatting.
//
// Pure data: no imports, no mutable module state (BL-347). The record is frozen deep.

export const ADAPTIVE_POLICY_VERSION = 'adaptive-policy/1'

/** MD-119's two candidate keep-down cap forms, plus today's per-site parity form. */
export type TraverseCapForm = 'per-site' | 'S/4 + a' | 'S/4 + 4a'

export interface AdaptivePolicy {
  version: string
  /** Parameter defaults and clamps the operation falls back to. */
  defaults: {
    helixDiameterPctOfTool: number
    minHelixRadiusMm: number
    toleranceMm: number
    stepoverFraction: number
    stepoverMin: number
    stepoverMax: number
    rampAngleDeg: number
    loopbackFilletPct: number
  }
  /** How finely paths, rides and levels are sampled. */
  sampling: {
    arcTolFraction: number
    arcTolFloorMm: number
    pathCleanTolerances: number
    seedSearchTolerances: number
    cycleCellTolerances: number
    cycleCellArcTols: number
    rideResampleMm: number
    rideWindowMm: number
    maxPriorMotionSamples: number
    chordFloorMm: number
    maxArcSegments: number
    wallTolArcTols: number
    wallTolToolRadii: number
    searchResolutionFloorMm: number
    residualSearchToolRadii: number
    slideStepArcTols: number
    slideStepStepoverDivisor: number
    startSearchStepDivisor: number
    clearAirSpacingToolRadii: number
    cutAreaCacheQuantMm: number
    cutAreaBoundHalfRadii: number
    cutAreaBoundMarginRadii: number
    minStepdownMm: number
    maxDepthLevels: number
    finishLeadFitSamples: number
  }
  /** The per-step heading search (FreeCAD findNextPoint) and the pass loop around it. */
  steering: {
    maxDeflectionDivisor: number
    maxIterations: number
    maxErrorRel: number
    historyLen: number
    loadSetpoint: number
    millingSideDeadband: number
    headingSamples: number
    minCutDivisor: number
    boundaryTaperRadii: number
    nearStepTolerances: number
    turnStepTolerances: number
    straightStepTolerances: number
    minStepTolerances: number
    maxStepRadiusDivisor: number
    orbitCloseTolerances: number
    orbitCloseSteps: number
    orbitCloseStepovers: number
    orbitCloseDot: number
    maxPasses: number
    maxPointsPerPass: number
    maxUnsafeStarts: number
    maxOverCutStreak: number
    endOverlapStepovers: number
  }
  /** Corner, wall-fillet and loopback rounding. */
  sharpening: {
    wallFilletMinRadiusDivisor: number
    wallFilletMinTurnDeg: number
    wallFilletLadderDivisors: readonly number[]
    departReachRadii: number
    cornerMinTurnDivisor: number
    cornerDiskBandDepths: number
    loopbackPctLadder: readonly number[]
    loopbackMaxArcSweepDeg: number
    loopbackReversalDeg: number
    rideOverlapFilletRadii: number
    rideMinMm: number
    rideMaxPerimeterFraction: number
    rideClampMarginMm: number
    loopbackMinRadiusMm: number
    loopbackChordFloorMm: number
    loopbackChordRadii: number
    loopbackMaxKinkDeg: number
    loopbackRideFraction: number
    loopbackMaxTurnDeg: number
    loopbackRadiusLadder: readonly number[]
    straightJoinTurnDeg: number
    straightJoinStubGapFraction: number
    straightJoinStubMaxMm: number
    joinTangentSlackGapFraction: number
    joinTangentSlackMm: number
    joinSweepToleranceDeg: number
    finishLeadMaxSweepDivisor: number
  }
  /** Load, engagement and keep-down caps. */
  caps: {
    rideCapStepovers: number
    slotCeilingDiameters: number
    cutThroughOptimalMultiple: number
    rideOverLenMaxMm: number
    emptyRideAreaTolerances: number
    engageBandBiteFactor: number
    walkerMinBiteFraction: number
    minPassBiteRatio: number
    engageProtrusionStepovers: number
    engageRejectAreaMultiple: number
    landingUncutCap: number
    sideReseedClearUncutMax: number
    minLandingRideLenMm: number
    liftDistanceMm: number
    keepToolDownDistRatio: number
    integralWallFollowLengthFactor: number
    floorHopFallbackBandMm: number
    workholdingIslandMarginMm: number
  }
  helix: {
    minDescentRadiusMm: number
    fitEpsMm: number
    angularStepDivisor: number
    edgeBackoffMm: number
    maxPoints: number
    minRadiusFraction: number
    minAngleDeg: number
  }
  /** MD-119 (BL-306 / Q-41): the walker band and the routed traverse each compute the
   *  engage move as S/4 plus a term. Today they differ (walker: + tolerance; traverse:
   *  + 4 x arcTol). Both candidate forms are carried; parity is 'per-site'. */
  traverseCap: {
    form: TraverseCapForm
    stepoverDivisor: number
    candidates: { readonly 'S/4 + a': { arcTolMultiple: number }; readonly 'S/4 + 4a': { arcTolMultiple: number } }
  }
}

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value as DeepReadonly<T>
}

export const ADAPTIVE_POLICY: DeepReadonly<AdaptivePolicy> = deepFreeze<AdaptivePolicy>({
  version: ADAPTIVE_POLICY_VERSION,
  defaults: {
    helixDiameterPctOfTool: 90,
    minHelixRadiusMm: 0.2,
    toleranceMm: 0.02,
    stepoverFraction: 0.4,
    stepoverMin: 0.01,
    stepoverMax: 0.95,
    rampAngleDeg: 3,
    loopbackFilletPct: 25,
  },
  sampling: {
    arcTolFraction: 0.25,
    arcTolFloorMm: 0.01,
    pathCleanTolerances: 0.25,
    seedSearchTolerances: 0.5,
    cycleCellTolerances: 2,
    cycleCellArcTols: 4,
    rideResampleMm: 0.75,
    rideWindowMm: 2.0,
    maxPriorMotionSamples: 4000,
    chordFloorMm: 0.05,
    maxArcSegments: 128,
    wallTolArcTols: 4,
    wallTolToolRadii: 0.05,
    searchResolutionFloorMm: 0.05,
    residualSearchToolRadii: 1.5,
    slideStepArcTols: 4,
    slideStepStepoverDivisor: 4,
    startSearchStepDivisor: 4,
    clearAirSpacingToolRadii: 0.25,
    cutAreaCacheQuantMm: 1e-3,
    cutAreaBoundHalfRadii: 4,
    cutAreaBoundMarginRadii: 2,
    minStepdownMm: 0.1,
    maxDepthLevels: 2000,
    finishLeadFitSamples: 8,
  },
  steering: {
    maxDeflectionDivisor: 4,
    maxIterations: 12,
    maxErrorRel: 0.05,
    historyLen: 10,
    loadSetpoint: 0.95,
    millingSideDeadband: 0.2,
    headingSamples: 5,
    minCutDivisor: 3,
    boundaryTaperRadii: 2,
    nearStepTolerances: 2,
    turnStepTolerances: 0.5,
    straightStepTolerances: 4,
    minStepTolerances: 2,
    maxStepRadiusDivisor: 2,
    orbitCloseTolerances: 2,
    orbitCloseSteps: 1.5,
    orbitCloseStepovers: 2,
    orbitCloseDot: 0.5,
    maxPasses: 5000,
    maxPointsPerPass: 20000,
    maxUnsafeStarts: 32,
    maxOverCutStreak: 5,
    endOverlapStepovers: 0.8,
  },
  sharpening: {
    wallFilletMinRadiusDivisor: 4,
    wallFilletMinTurnDeg: 5,
    wallFilletLadderDivisors: [1, 2, 4],
    departReachRadii: 1.5,
    cornerMinTurnDivisor: 18,
    cornerDiskBandDepths: 4,
    loopbackPctLadder: [1, 0.5, 0.25, 0.125],
    loopbackMaxArcSweepDeg: 185,
    loopbackReversalDeg: 175,
    rideOverlapFilletRadii: 1.5,
    rideMinMm: 3.0,
    rideMaxPerimeterFraction: 0.25,
    rideClampMarginMm: 0.02,
    loopbackMinRadiusMm: 0.05,
    loopbackChordFloorMm: 0.005,
    loopbackChordRadii: 0.0015,
    loopbackMaxKinkDeg: 45,
    loopbackRideFraction: 0.9,
    loopbackMaxTurnDeg: 181,
    loopbackRadiusLadder: [1, 0.5, 0.25, 0.1],
    straightJoinTurnDeg: 0.5,
    straightJoinStubGapFraction: 0.25,
    straightJoinStubMaxMm: 0.5,
    joinTangentSlackGapFraction: 0.1,
    joinTangentSlackMm: 0.05,
    joinSweepToleranceDeg: 2.0,
    finishLeadMaxSweepDivisor: 2,
  },
  caps: {
    rideCapStepovers: 1.5,
    slotCeilingDiameters: 0.75,
    cutThroughOptimalMultiple: 2,
    rideOverLenMaxMm: 2.0,
    emptyRideAreaTolerances: 2.0,
    engageBandBiteFactor: 1.5,
    walkerMinBiteFraction: 0.02,
    minPassBiteRatio: 0.25,
    engageProtrusionStepovers: 0.1,
    engageRejectAreaMultiple: 2,
    landingUncutCap: 0.05,
    sideReseedClearUncutMax: 0.005,
    minLandingRideLenMm: 0.5,
    liftDistanceMm: 2.0,
    keepToolDownDistRatio: 3.0,
    integralWallFollowLengthFactor: 2,
    floorHopFallbackBandMm: 0.1,
    workholdingIslandMarginMm: 0.05,
  },
  helix: {
    minDescentRadiusMm: 0.2,
    fitEpsMm: 0.01,
    angularStepDivisor: 16,
    edgeBackoffMm: 0.01,
    maxPoints: 5000,
    minRadiusFraction: 0.5,
    minAngleDeg: 1,
  },
  traverseCap: {
    form: 'per-site',
    stepoverDivisor: 4,
    candidates: { 'S/4 + a': { arcTolMultiple: 1 }, 'S/4 + 4a': { arcTolMultiple: 4 } },
  },
})

/**
 * WO-3041 switch (the operator 10-21: adaptive must clear the pocket; motion changes ship OFF behind
 * a before/after card). OFF: an operation whose entry is a plunge (helix diameter 0) opens a
 * hole exactly one tool wide, every first pass out of it is a full slot, and the deep
 * H-pocket cuts nothing (WO-3024 finding). ON: the plunge is kept and, at depth, an opening
 * ring (an outward spiral closed by one full circle, its sustained width held to the
 * operator's stepover and checked against the 75%-of-slot ceiling) grows the hole to the
 * disk a default helix would open; the walker then takes over as it does from a helix seed.
 * Helix, ramp and side entries are not touched. Turning it on is this one line.
 */
export const ADAPTIVE_MOTION_SWITCHES: Readonly<{ plungeOpeningRing: boolean; keepDownCapForm: boolean }> = Object.freeze({
  plungeOpeningRing: false,
  /** WO-3030 (WO-3019 item 8, card D): OFF keeps MD-119's per-site parity (walker band
   *  S/4 + tolerance, routed traverse S/4 + 4 x arcTol). ON: both sites use the S/4 + 4a form
   *  (KEEP_DOWN_CAP_SWITCH_FORM). The two forms are the same number whenever tolerance >= 0.04 mm
   *  (arcTol = max(tolerance/4, 0.01)); below that the walker band widens to the traverse's. */
  keepDownCapForm: false,
})

/** The MD-119 form the WO-3030 switch selects at both keep-down cap sites. */
export const KEEP_DOWN_CAP_SWITCH_FORM: TraverseCapForm = 'S/4 + 4a'

const KEEP_DOWN_CAP_SWITCH_POLICY = deepFreeze({
  ...ADAPTIVE_POLICY,
  traverseCap: { ...ADAPTIVE_POLICY.traverseCap, form: KEEP_DOWN_CAP_SWITCH_FORM },
}) as DeepReadonly<AdaptivePolicy>

/** The record both keep-down cap sites hand adaptiveEngageMoveDistance. The caller reads the
 *  switch (ADAPTIVE_MOTION_SWITCHES.keepDownCapForm) and passes it in; OFF is ADAPTIVE_POLICY itself. */
export function adaptiveKeepDownCapPolicy(switchOn: boolean): DeepReadonly<AdaptivePolicy> {
  return switchOn ? KEEP_DOWN_CAP_SWITCH_POLICY : ADAPTIVE_POLICY
}

/** The engage move both keep-down caps are built on (MD-119). `site` names the caller:
 *  'walker' is the engage-band walker (processFeature), 'traverse' the routed keep-down
 *  traverse cap, which has no tolerance in scope and passes undefined. Per-site parity
 *  keeps today's two expressions to the bit. */
export function adaptiveEngageMoveDistance(
  site: 'walker' | 'traverse',
  stepOverDistance: number,
  tolerance: number | undefined,
  arcTol: number,
  policy: DeepReadonly<AdaptivePolicy> = ADAPTIVE_POLICY,
): number {
  const cap = policy.traverseCap
  if (cap.form === 'per-site') {
    return site === 'walker'
      ? stepOverDistance / cap.stepoverDivisor + (tolerance as number)
      : stepOverDistance / cap.stepoverDivisor + arcTol * cap.candidates['S/4 + 4a'].arcTolMultiple
  }
  return stepOverDistance / cap.stepoverDivisor + arcTol * cap.candidates[cap.form].arcTolMultiple
}

/** Where each value was read on the WO-3018 starter (855ea4d9), engine file:line.
 *  src/tests/evidence/WO-3018/policy-sites.json has the exact text replaced at each site. */
export const ADAPTIVE_POLICY_SOURCES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'caps.cutThroughOptimalMultiple': ['processFeature.ts:5661', 'processFeature.ts:5983'],
  'caps.emptyRideAreaTolerances': ['processFeature.ts:2443', 'processFeature.ts:2794', 'processFeature.ts:2875'],
  'caps.engageBandBiteFactor': ['processFeature.ts:1575', 'processFeature.ts:3711'],
  'caps.engageProtrusionStepovers': ['engagePoint.ts:92'],
  'caps.engageRejectAreaMultiple': ['engagePoint.ts:148'],
  'caps.floorHopFallbackBandMm': ['rapidCorridor.ts:8'],
  'caps.integralWallFollowLengthFactor': ['processFeature.ts:587'],
  'caps.keepToolDownDistRatio': ['processFeature.ts:3898'],
  'caps.landingUncutCap': ['processFeature.ts:3878'],
  'caps.liftDistanceMm': ['processFeature.ts:3886'],
  'caps.minLandingRideLenMm': ['processFeature.ts:3905'],
  'caps.minPassBiteRatio': ['processFeature.ts:1592'],
  'caps.rideCapStepovers': ['processFeature.ts:1953', 'processFeature.ts:2805', 'processFeature.ts:2965', 'processFeature.ts:4586', 'processFeature.ts:5128', 'processFeature.ts:5347', 'processFeature.ts:5374', 'processFeature.ts:5713', 'processFeature.ts:6310', 'processFeature.ts:6320'],
  'caps.rideOverLenMaxMm': ['processFeature.ts:2457', 'processFeature.ts:2796', 'processFeature.ts:2879'],
  'caps.sideReseedClearUncutMax': ['processFeature.ts:3902'],
  'caps.slotCeilingDiameters': ['processFeature.ts:2456', 'processFeature.ts:2795', 'processFeature.ts:2878', 'processFeature.ts:4908', 'processFeature.ts:5661', 'processFeature.ts:5983', 'processFeature.ts:6405'],
  'caps.walkerMinBiteFraction': ['processFeature.ts:1581'],
  'caps.workholdingIslandMarginMm': ['workholdingIsland.ts:37'],
  'defaults.helixDiameterPctOfTool': ['index.ts:42'],
  'defaults.loopbackFilletPct': ['index.ts:123', 'wallCleanLoop.ts:125', 'wallCleanLoop.ts:138', 'wallCleanLoop.ts:164', 'wallCleanLoop.ts:225', 'wallCleanLoop.ts:473', 'wallCleanLoop.ts:742', 'loopbackFillet.ts:106'],
  'defaults.minHelixRadiusMm': ['index.ts:43'],
  'defaults.rampAngleDeg': ['index.ts:107'],
  'defaults.stepoverFraction': ['index.ts:45'],
  'defaults.stepoverMax': ['index.ts:100'],
  'defaults.stepoverMin': ['index.ts:100'],
  'defaults.toleranceMm': ['index.ts:44'],
  'helix.angularStepDivisor': ['emit.ts:87', 'emit.ts:408'],
  'helix.edgeBackoffMm': ['emit.ts:88'],
  'helix.fitEpsMm': ['processFeature.ts:4152'],
  'helix.maxPoints': ['emit.ts:89'],
  'helix.minAngleDeg': ['emit.ts:182', 'emit.ts:193', 'emit.ts:267'],
  'helix.minDescentRadiusMm': ['processFeature.ts:4149'],
  'helix.minRadiusFraction': ['emit.ts:401'],
  'sampling.arcTolFloorMm': ['processFeature.ts:871'],
  'sampling.arcTolFraction': ['processFeature.ts:871'],
  'sampling.chordFloorMm': ['processFeature.ts:4015', 'processFeature.ts:4055', 'processFeature.ts:4121'],
  'sampling.clearAirSpacingToolRadii': ['processFeature.ts:3955'],
  'sampling.cutAreaBoundHalfRadii': ['toolGeometry.ts:196'],
  'sampling.cutAreaBoundMarginRadii': ['toolGeometry.ts:197'],
  'sampling.cutAreaCacheQuantMm': ['toolGeometry.ts:168'],
  'sampling.cycleCellArcTols': ['processFeature.ts:1845'],
  'sampling.cycleCellTolerances': ['processFeature.ts:1845'],
  'sampling.finishLeadFitSamples': ['emit.ts:96'],
  'sampling.maxArcSegments': ['processFeature.ts:4016', 'processFeature.ts:4056', 'processFeature.ts:4122'],
  'sampling.maxDepthLevels': ['index.ts:474', 'emit.ts:131'],
  'sampling.maxPriorMotionSamples': ['processFeature.ts:5172'],
  'sampling.minStepdownMm': ['index.ts:470', 'emit.ts:127'],
  'sampling.pathCleanTolerances': ['processFeature.ts:2214', 'processFeature.ts:2215', 'processFeature.ts:2429', 'processFeature.ts:3114', 'processFeature.ts:2802', 'processFeature.ts:2631'],
  'sampling.residualSearchToolRadii': ['processFeature.ts:3225'],
  'sampling.rideResampleMm': ['processFeature.ts:3606', 'processFeature.ts:3665'],
  'sampling.rideWindowMm': ['processFeature.ts:3595', 'processFeature.ts:3660', 'processFeature.ts:3711'],
  'sampling.searchResolutionFloorMm': ['processFeature.ts:3225', 'processFeature.ts:3844'],
  'sampling.seedSearchTolerances': ['processFeature.ts:1215', 'processFeature.ts:1439', 'processFeature.ts:3543'],
  'sampling.slideStepArcTols': ['processFeature.ts:3379'],
  'sampling.slideStepStepoverDivisor': ['processFeature.ts:3379'],
  'sampling.startSearchStepDivisor': ['processFeature.ts:3399'],
  'sampling.wallTolArcTols': ['processFeature.ts:1538', 'processFeature.ts:1661', 'processFeature.ts:2608', 'processFeature.ts:4997', 'processFeature.ts:5184', 'processFeature.ts:5328', 'processFeature.ts:6995'],
  'sampling.wallTolToolRadii': ['processFeature.ts:1538', 'processFeature.ts:1661', 'processFeature.ts:2608', 'processFeature.ts:4997', 'processFeature.ts:5184', 'processFeature.ts:5328', 'processFeature.ts:6995'],
  'sharpening.cornerDiskBandDepths': ['processFeature.ts:1174'],
  'sharpening.cornerMinTurnDivisor': ['processFeature.ts:1171'],
  'sharpening.departReachRadii': ['processFeature.ts:1943'],
  'sharpening.finishLeadMaxSweepDivisor': ['emit.ts:95'],
  'sharpening.joinSweepToleranceDeg': ['wallCleanLoop.ts:379'],
  'sharpening.joinTangentSlackGapFraction': ['wallCleanLoop.ts:340'],
  'sharpening.joinTangentSlackMm': ['wallCleanLoop.ts:340'],
  'sharpening.loopbackChordFloorMm': ['wallCleanLoop.ts:530'],
  'sharpening.loopbackChordRadii': ['wallCleanLoop.ts:530'],
  'sharpening.loopbackMaxArcSweepDeg': ['loopbackFillet.ts:134'],
  'sharpening.loopbackMaxKinkDeg': ['wallCleanLoop.ts:584', 'wallCleanLoop.ts:585', 'wallCleanLoop.ts:656'],
  'sharpening.loopbackMaxTurnDeg': ['wallCleanLoop.ts:592'],
  'sharpening.loopbackMinRadiusMm': ['wallCleanLoop.ts:529'],
  'sharpening.loopbackPctLadder': ['loopbackFillet.ts:98'],
  'sharpening.loopbackRadiusLadder': ['wallCleanLoop.ts:667'],
  'sharpening.loopbackReversalDeg': ['loopbackFillet.ts:135'],
  'sharpening.loopbackRideFraction': ['wallCleanLoop.ts:538', 'wallCleanLoop.ts:539', 'wallCleanLoop.ts:553'],
  'sharpening.rideClampMarginMm': ['wallCleanLoop.ts:400'],
  'sharpening.rideMaxPerimeterFraction': ['wallCleanLoop.ts:128'],
  'sharpening.rideMinMm': ['wallCleanLoop.ts:128'],
  'sharpening.rideOverlapFilletRadii': ['wallCleanLoop.ts:127'],
  'sharpening.straightJoinStubGapFraction': ['wallCleanLoop.ts:304'],
  'sharpening.straightJoinStubMaxMm': ['wallCleanLoop.ts:304'],
  'sharpening.straightJoinTurnDeg': ['wallCleanLoop.ts:301'],
  'sharpening.wallFilletLadderDivisors': ['processFeature.ts:1685'],
  'sharpening.wallFilletMinRadiusDivisor': ['processFeature.ts:1659'],
  'sharpening.wallFilletMinTurnDeg': ['processFeature.ts:1660'],
  'steering.boundaryTaperRadii': ['processFeature.ts:1900'],
  'steering.endOverlapStepovers': ['processFeature.ts:3264'],
  'steering.headingSamples': ['processFeature.ts:1840'],
  'steering.historyLen': ['steering.ts:86'],
  'steering.loadSetpoint': ['steering.ts:87', 'processFeature.ts:1474'],
  'steering.maxDeflectionDivisor': ['steering.ts:82', 'interpolation.ts:67'],
  'steering.maxErrorRel': ['steering.ts:84'],
  'steering.maxIterations': ['steering.ts:83'],
  'steering.maxOverCutStreak': ['processFeature.ts:2291'],
  'steering.maxPasses': ['processFeature.ts:597'],
  'steering.maxPointsPerPass': ['processFeature.ts:598'],
  'steering.maxStepRadiusDivisor': ['processFeature.ts:1913'],
  'steering.maxUnsafeStarts': ['processFeature.ts:1824'],
  'steering.millingSideDeadband': ['steering.ts:79'],
  'steering.minCutDivisor': ['processFeature.ts:1901'],
  'steering.minStepTolerances': ['processFeature.ts:1913'],
  'steering.nearStepTolerances': ['processFeature.ts:1910'],
  'steering.orbitCloseDot': ['processFeature.ts:2130', 'processFeature.ts:2136'],
  'steering.orbitCloseStepovers': ['processFeature.ts:2128', 'processFeature.ts:2135'],
  'steering.orbitCloseSteps': ['processFeature.ts:2129'],
  'steering.orbitCloseTolerances': ['processFeature.ts:2129'],
  'steering.straightStepTolerances': ['processFeature.ts:1912'],
  'steering.turnStepTolerances': ['processFeature.ts:1911'],
  'traverseCap.candidates': ['processFeature.ts:1573', 'processFeature.ts:3710'],
  'traverseCap.form': ['processFeature.ts:1573', 'processFeature.ts:3710'],
  'traverseCap.stepoverDivisor': ['processFeature.ts:1573', 'processFeature.ts:3710'],
})
