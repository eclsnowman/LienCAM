// SPDX-License-Identifier: LGPL-2.1-or-later
// Ported from FreeCAD's Adaptive2d (src/Mod/CAM/libarea/Adaptive.cpp and Path Adaptive Python), Copyright (c) 2018 Kresimir Tusek.
// This file remains under LGPL-2.1-or-later; the LienCAM project as a whole is distributed under GPL-3.0-or-later (see /LICENSE).
// Adaptive-clearing engine entry (FreeCAD port). Maps an ACWorkerPayload to the
// engine's ProcessParams + Feature(s), runs processFeature per feature, and emits the
// multi-depth ToolpathMove[] via emitFeature. Mirrors FreeCAD OpExecute -> per-feature
// ProcessFeature -> GenerateGCode.
//
// This is the Phase-5 entry. It lands UNWIRED: the worker still imports the old
// planner from ../index.ts; Phase 6 repoints COMPUTE_ADAPTIVE_CLEARING here (and adds
// `await`, since this is async -- the clipper2-wasm engine needs a one-time init).
//
// Boundary contract (operation contract): payload in, ToolpathMove[] out. No payload
// mutation, no global state.

import type { ToolpathMove } from '../../../../types'
import {
  resolveAdaptiveMillingDirection,
  type ACWorkerPayload,
} from '../../types'
import { resolveHeights } from '../../heights'
import { resolveFeedrates } from '../../feedrates'
import { signedArea } from '../../geometry'
import { assertToolFluteReach } from '../../toolFluteReach'
import { directionForTool } from '../../../tool/cutHand'
import { ensureEngineClipperReady, pointInPolygon, type Loop } from './clipperEngine'
import { centroid } from './geom'
import { processFeature, reportRepositionChoices, restoreFeatureStats, snapshotFeatureStats, type Feature, type FeatureResult, type FeatureStatsSnapshot, type ProcessParams, type RepositionChoiceTrace } from './processFeature'
import { emitFeature, type EmitContext } from './emit'
import type { RepositionTimeModel } from './repositionTime'
import { withOperatorNotices } from './operatorNotices'
import { estimateRuntimeMs } from '../../runtime'
import { ensureClipperReady } from '../../face2d/clipperOffset'
import { clearanceAllowanceMmOf, type ToolReachInputs } from '../../holderClearanceGate'
import {
  reduceRegionAroundKeepOuts, workholdingDepthBands, workholdingIslandNotice,
} from './workholdingIsland'

// Sensible defaults for the user-settable engine params (ACParams.helixDiameter /
// .tolerance). Defaults live here so a payload that omits them still runs.
const DEFAULT_HELIX_DIAMETER_PCT = 90   // % of tool diameter
const DEFAULT_MIN_HELIX_RADIUS_MM = 0.2
const DEFAULT_TOLERANCE_MM = 0.02
const DEFAULT_STEPOVER_FRACTION = 0.4   // fallback only if passes.stepover is unusable

/** Plain words for FeatureResult.stats.aborted, for the operator notice (WO-1540). */
const ABORT_REASON_WORDS: Record<string, string> = {
  'no-cut-region': 'there was nothing left to cut',
  'no-start-point': 'no safe place to enter the material was found',
  'unsafe-re-entry': 'no safe way back into the material was found',
  'over-cut': 'the path kept re-cutting cleared ground',
  'wall-rim-overload': 'part of the wall finish would overload the tool',
  'wall-coverage-direction': 'part of the wall could not be cut in the chosen milling direction',
  'max-passes': 'the pass limit was reached with material still standing',
}

export async function buildAdaptiveClearingToolpath(
  payload: ACWorkerPayload,
  onProgress?: (fraction: number, phase?: string) => void,
  notify?: (message: string) => void,
): Promise<ToolpathMove[]> {
  const { params, tool, heights, passes, loops, loopOrigins, wcsOrigin } = payload

  const toolDia = tool.diameter
  const toolRadius = toolDia / 2
  if (!(toolRadius > 0)) {
    console.warn('[ac-engine] tool diameter <= 0; no toolpath emitted')
    notify?.('the tool diameter is not above zero, so no toolpath was generated.')
    return []
  }

  await ensureEngineClipperReady()
  onProgress?.(0.1, 'Preparing region')

  // Honor the user's loop selection: only the picked loops define the feature. An empty
  // selection means "all closed loops". The store passes EVERY loop in the geometry
  // (resolvedLoops is unfiltered); each builder filters by params.loopIds itself.
  const pickedFeatures = extractFeatures(loops, params.loopIds ?? [], loopOrigins)
  if (pickedFeatures.length === 0) {
    // ADR 0003 (SKC-47-R2 truth-fix): this WAS console.warn + return [] — a genuinely
    // silent end-to-end failure for a geometry-boundary op (unlike Face/Pocket, there is
    // no store-level pre-dispatch guard for AC's 'geometry' branch). Fail loud instead so
    // the op surfaces status 'error' through the existing TOOLPATH_ERROR path.
    throw new Error('Adaptive Clearing: no closed loop found to clear. Select a closed contour in the Geometry tab.')
  }

  // Param mapping (ACWorkerPayload -> engine ProcessParams). stepover is mm radial in
  // PassParams; the engine wants a fraction of tool DIAMETER.
  const tolerance = positiveOr(params.tolerance, DEFAULT_TOLERANCE_MM)
  let stepOver = passes.stepover / toolDia
  if (!Number.isFinite(stepOver) || stepOver <= 0) {
    console.warn(`[ac-engine] unusable stepover ${passes.stepover}mm; using ${DEFAULT_STEPOVER_FRACTION} of diameter`)
    notify?.(
      `stepover ${passes.stepover} mm is unusable, so ${(DEFAULT_STEPOVER_FRACTION * toolDia).toFixed(2)} mm ` +
      `(${DEFAULT_STEPOVER_FRACTION * 100}% of the tool diameter) was used instead.`,
    )
    stepOver = DEFAULT_STEPOVER_FRACTION
  }
  stepOver = Math.min(Math.max(stepOver, 0.01), 0.95)
  // Entry type: a 'plunge' choice forces helixDiameter 0, so processFeature seeds every
  // region with a straight plunge instead of a helix ramp. Otherwise the helix diameter
  // is a percentage of tool diameter (processFeature still falls back to a plunge where a
  // helix will not fit a tight pocket).
  const forcePlunge = payload.linking?.entryType === 'plunge'
  const helixDiameter = forcePlunge ? 0 : toolDia * (positiveOr(params.helixDiameter, DEFAULT_HELIX_DIAMETER_PCT) / 100)
  const helixAngleDeg = positiveOr(params.rampAngle, payload.linking?.rampAngle ?? 3)
  const millingDirection = directionForTool(
    resolveAdaptiveMillingDirection(params.climb),
    tool,
  )

  const procParams: ProcessParams = {
    toolRadius,
    stepOver,
    tolerance,
    helixDiameter,
    millingDirection,
    stockToLeave: passes.stockToLeave ?? 0,
    integralWallFollow: params.integralWallFollow ?? true,
    integralWallFollowLengthFactor: params.integralWallFollowLengthFactor,
    wallCleanupAsWeGo: params.wallCleanupAsWeGo ?? false,
    loopbackFilletPct: params.loopbackFilletPct ?? 25,
    wallFinish: params.wallFinish ?? false,
    // WO-450 escape hatch, off unless the operation asks for it. FALSE = the wall-finish lap
    // leaves passes.stockToLeave standing; TRUE = it rides the true wall and cuts to net.
    //
    // WO-1043: 'final_to_size' is the user-facing way to ask for exactly that lap geometry,
    // so it RESOLVES INTO this same flag rather than adding a second geometry path. That is
    // sound because processFeature plans ONE depth-agnostic 2D path and 'final_to_size'
    // shares 'final''s depth schedule -- the lap is emitted at the bottom level and nowhere
    // else, so a feature-level to-net contour IS a bottom-level-only to-net contour. The
    // ROUGHING stream is untouched either way: the lap's credited annulus
    // [wallFinishNearDepth, finishStock] lies entirely above the finishStock line at both
    // settings, so finishBand and walkerRegion are byte-identical (processFeature ~785).
    // An EXPLICIT wallFinishToNet still wins, so any project file that set it is unchanged.
    wallFinishToNet: params.wallFinishToNet ?? (params.wallFinishMode === 'final_to_size'),
  }

  const resolvedHeights = resolveHeights(heights, wcsOrigin)
  // Axial (floor) stock to leave: the floor analog of the radial passes.stockToLeave
  // (which flows into processFeature's finishStock as an XY inset). AC clears in depth
  // levels from topZ down to bottomZ; leaving floor stock means raising the clearing
  // floor by `axialStock` so the deepest level stops that far above the true bottom.
  // The 2D path (processFeature) is depth-agnostic, so this is purely an emit-floor
  // shift. axialStock = 0 -> heights unchanged -> byte-identical to prior behavior
  // (the 9-fixture fingerprint). wallFollowStockToLeave is a SEPARATE radial finish
  // offset and is left untouched.
  const axialStock = Math.max(0, passes.floorStockToLeave ?? 0)
  const emitHeights = axialStock > 0
    ? { ...resolvedHeights, bottomZ: resolvedHeights.bottomZ + axialStock }
    : resolvedHeights
  const deepestCutZ = params.floorFinish === true
    ? resolvedHeights.bottomZ
    : emitHeights.bottomZ
  assertToolFluteReach({
    operation: 'Adaptive Clearing',
    topZ: resolvedHeights.topZ,
    bottomZ: deepestCutZ,
    fluteLength: tool.fluteLength,
  })
  const feeds = resolveFeedrates(tool, payload.feedrateOverride, payload.machineRapidRate)
  const emitCtx: EmitContext = {
    heights: emitHeights,
    feeds,
    stepdown: passes.stepdown,
    helixAngleDeg,
    millingDirection,
    minHelixRadius: positiveOr(params.minHelixRadius, DEFAULT_MIN_HELIX_RADIUS_MM),
    wallFinishMode: params.wallFinishMode ?? 'final',
    finishLeadInRadius: payload.linking.leadInRadius,
    finishLeadOutRadius: payload.linking.leadOutRadius,
    ...(params.floorFinish === true ? { floorFinishDepth: resolvedHeights.bottomZ } : {}),
  }

  const floorFinishDepth = params.floorFinish === true ? resolvedHeights.bottomZ : undefined
  // WO-2787 round 5: timing and emission share execution's one feed resolver. G0
  // uses the dispatch-time machine rapid; a stay-down fast_traverse uses the
  // separately resolved (possibly slower) feed. Older direct-engine requests
  // without machine data retain their historical fast-traverse fallback.
  // WO-2787 round 6: the model is the feature's own emit context, so each candidate is
  // priced at the roles emit writes it with on every level, floor replay included.
  const repositionTimeFor = (ctx: EmitContext): RepositionTimeModel => ({
    ctx,
    rapidRate: payload.machineRapidRate ?? ctx.feeds.fastTraverseRate,
  })
  const runs = await featureRunsAroundWorkholding(pickedFeatures, payload, {
    topZ: emitHeights.topZ,
    roughBottomZ: emitHeights.bottomZ,
    stepdown: passes.stepdown,
    floorFinishDepth,
    reachTopZ: resolvedHeights.topZ + Math.max(0, tool.fluteLength || 0),
  }, notify)
  const features = runs.map(run => run.feature)

  const allMoves: ToolpathMove[] = []
  for (let f = 0; f < features.length; f++) {
    onProgress?.(0.1 + 0.8 * (f / features.length), 'Clearing region')
    // Remap this feature's local completion fraction (0..1) into the overall 0.1..0.9 band.
    // With exactly one feature this threads real per-pass progress between the 0.1 and 1.0
    // emits; the base offset keeps multi-feature behavior sane (each feature spans its slice).
    const featureBase = 0.1 + 0.8 * (f / features.length)
    const featureSpan = 0.8 / features.length
    const onPassProgress = onProgress
      ? (frac: number) => onProgress(featureBase + featureSpan * frac, 'Clearing region')
      : undefined
    const { origin, ...feature } = features[f]
    const run = runs[f]
    const runCtx: EmitContext = run.topZ === undefined ? emitCtx : {
      ...emitCtx,
      heights: { ...emitHeights, topZ: run.topZ, bottomZ: run.bottomZ as number },
      floorFinishDepth: run.floorFinish ? floorFinishDepth : undefined,
    }
    const result = await processFeatureFastest(feature, procParams, repositionTimeFor(runCtx), runCtx, notify, onPassProgress)
    // ADR-0003: surface a partial/aborted feature; do not silently swallow it.
    if (result.stats.aborted) {
      console.warn(`[ac-engine] feature ${f} aborted: ${result.stats.aborted} (emitting ${result.passes.length} partial passes)`)
      const why = ABORT_REASON_WORDS[result.stats.aborted] ?? result.stats.aborted
      notify?.(
        `region ${f + 1} of ${features.length} stopped early because ${why}; ` +
        `the ${result.passes.length} pass(es) planned before that are kept.`,
      )
    }
    const featureMoves = withOperatorNotices(notify, () => emitFeature(result, runCtx))
    // emitFeature can return tens of thousands of moves for a full-stock region.
    // `push(...bigArray)` spreads every element as a separate call argument, which
    // overflows the (smaller) Web Worker stack -- "Maximum call stack size
    // exceeded" -- even though node's larger stack survives the same call. Append
    // iteratively instead: O(n), no spread, no per-element stack frame.
    if (origin.x === 0 && origin.y === 0) {
      for (let i = 0; i < featureMoves.length; i++) allMoves.push(featureMoves[i])
    } else {
      for (let i = 0; i < featureMoves.length; i++) {
        const move = featureMoves[i]
        allMoves.push({
          ...move,
          x: move.x + origin.x,
          y: move.y + origin.y,
          ...(typeof move.cx === 'number' ? { cx: move.cx + origin.x } : {}),
          ...(typeof move.cy === 'number' ? { cy: move.cy + origin.y } : {}),
        })
      }
    }
  }

  onProgress?.(1.0, 'Done')
  return allMoves
}

/** Split the loop set into features. Only the loops the user picked (`loopIds`) are
 *  considered; an empty selection means all closed loops. Each contour/boundary is an
 *  independent feature, in source order, so an All Parts operation machines every
 *  disjoint part deterministically. Holes are assigned to the smallest containing
 *  boundary. The largest-loop fallback preserves legacy behavior for untyped or
 *  hole-only payloads. */
type FeatureOrigin = { x: number; y: number }
type LocalFeature = Feature & { origin: FeatureOrigin }
type ClassifiedLoop = {
  sourceIndex: number
  type: ACWorkerPayload['loops'][number]['type']
  loop: Loop
  localLoop: Loop
  localAbsArea: number
  origin: FeatureOrigin
}

function extractFeatures(
  loops: ACWorkerPayload['loops'],
  loopIds: string[],
  loopOrigins: ACWorkerPayload['loopOrigins'] = {},
): LocalFeature[] {
  const picked = loopIds.length > 0 ? loops.filter(l => loopIds.includes(l.id)) : loops
  const closed = picked
    .filter(l => l.closed && l.points.length >= 3)
    .map((l, sourceIndex): ClassifiedLoop => {
      const loop = l.points.map(p => ({ x: p.x, y: p.y })) as Loop
      const origin = loopOrigins[l.id] ?? { x: 0, y: 0 }
      // Classification is part of planning: even area ordering must not see the
      // world placement. Hole containment below uses each candidate boundary's
      // frame because the owning feature is not known until that predicate runs.
      const localLoop = toLocalLoop(loop, origin)
      return {
        sourceIndex,
        type: l.type,
        loop,
        localLoop,
        localAbsArea: Math.abs(signedArea(localLoop)),
        origin,
      }
    })
  if (closed.length === 0) return []

  const boundaries = closed.filter(l => l.type !== 'hole')
  if (boundaries.length === 0) {
    // Largest first: it is the outer, and a loop inside it is its hole.
    // WO-2859: a loop inside NO larger picked loop is a region of its own - an
    // STL's bores carry 'hole' winding, and two picked bores (on one plate, or
    // one on each copy) are two regions. This used to keep only the largest
    // and silently drop the rest.
    const byArea = closed
      .map((_, i) => i)
      .sort((a, b) => closed[b].localAbsArea - closed[a].localAbsArea || a - b)
    const outers: number[] = []
    const holesOf = new Map<number, ClassifiedLoop[]>()
    for (const i of byArea) {
      const candidate = closed[i]
      const owner = outers
        .filter(o => pointInPolygon(
          centroid(toLocalLoop(candidate.loop, closed[o].origin)),
          closed[o].localLoop,
        ) >= 0)
        .sort((a, b) => closed[a].localAbsArea - closed[b].localAbsArea)[0]
      if (owner === undefined) {
        outers.push(i)
        holesOf.set(i, [])
      } else {
        holesOf.get(owner)!.push(candidate)
      }
    }
    return outers.sort((a, b) => a - b).map(o => toLocalFeature(
      closed[o],
      holesOf.get(o)!.sort((a, b) => a.sourceIndex - b.sourceIndex).map(l => l.loop),
    ))
  }

  const holesByBoundary = new Map<number, Loop[]>()
  for (const hole of closed.filter(l => l.type === 'hole')) {
    const owner = boundaries
      .map(boundary => ({
        boundary,
        holeInFeatureFrame: toLocalLoop(hole.loop, boundary.origin),
      }))
      .filter(({ boundary, holeInFeatureFrame }) =>
        pointInPolygon(centroid(holeInFeatureFrame), boundary.localLoop) >= 0)
      .sort((a, b) =>
        a.boundary.localAbsArea - b.boundary.localAbsArea ||
        a.boundary.sourceIndex - b.boundary.sourceIndex)[0]?.boundary
    if (owner) {
      const ownedHoles = holesByBoundary.get(owner.sourceIndex) ?? []
      ownedHoles.push(hole.loop)
      holesByBoundary.set(owner.sourceIndex, ownedHoles)
    }
  }

  return boundaries.map(boundary => toLocalFeature(
    boundary,
    holesByBoundary.get(boundary.sourceIndex) ?? [],
  ))
}

/** One region to plan and the depth range it is cut over. `topZ` absent: the
 *  operation's own heights, exactly as without workholding. */
interface FeatureRun {
  feature: LocalFeature
  topZ?: number
  bottomZ?: number
  /** This run ends with the floor-finish replay. */
  floorFinish?: boolean
}

interface DepthSchedule {
  topZ: number
  roughBottomZ: number
  stepdown: number
  floorFinishDepth: number | undefined
  /** The highest Z the cutter reaches while cutting: the shallowest cut plus the flute length. */
  reachTopZ: number
}

/** WO-2787 fix round 7: THE WHOLE PROGRAM DECIDES THE CLOSE CALLS. processFeature prices
 *  each would-lift reposition as the motion emit writes for it, and charges a lift the WO-447
 *  gap-fill ride over wall a kept-down ride would have covered. That charge is the one part it
 *  cannot know when it decides: a later pass may cover the same wall anyway. Measured on
 *  gt_fix8 (floor replay, finishing feed 200): the wall arc was credited 29 mm of wall, a later
 *  pass covered 9.3 mm of it in the lifted program, and the lifted program ran 1038.8 ms
 *  faster. So where a decision rests on that charge -- an alternative would win without it --
 *  the feature is planned again with that alternative forced, both programs are emitted and
 *  timed with the op card's estimate, and the faster one is kept. Every other decision is
 *  final as made, and a feature with none plans once. The fail-loud lines, operator notices
 *  and run counters reported are those of the program kept. */
async function processFeatureFastest(
  feature: Feature, procParams: ProcessParams, model: RepositionTimeModel, ctx: EmitContext,
  notify: ((message: string) => void) | undefined, onPassProgress: ((frac: number) => void) | undefined,
): Promise<FeatureResult> {
  type Forced = { connStart: { x: number; y: number }; connEnd: { x: number; y: number }; rung: string }
  type Run = { result: FeatureResult; decisions: RepositionChoiceTrace[]; warnings: unknown[][]; notices: string[]; stats: FeatureStatsSnapshot }
  const same = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9
  const plan = (forced: Forced[], trial: boolean): Run => {
    const decisions: RepositionChoiceTrace[] = []
    const warnings: unknown[][] = []
    const notices: string[] = []
    const timed: RepositionTimeModel = {
      ...model,
      onChoice: decided => { decisions.push(decided) },
      ...(forced.length > 0 ? { force: (a, b) => forced.find(f => same(f.connStart, a) && same(f.connEnd, b))?.rung ?? null } : {}),
      ...(trial ? { trial: true as const } : {}),
    }
    const warn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    try {
      const result = withOperatorNotices(message => { notices.push(message) },
        () => processFeature(feature, { ...procParams, repositionTime: timed }, trial ? undefined : onPassProgress))
      return { result, decisions, warnings, notices, stats: snapshotFeatureStats() }
    } catch (error) {
      if (!trial) { console.warn = warn; report({ warnings, notices, decisions }) }
      throw error
    } finally {
      console.warn = warn
    }
  }
  const report = (run: Pick<Run, 'warnings' | 'notices' | 'decisions'>): void => {
    for (const args of run.warnings) console.warn(...args)
    for (const message of run.notices) notify?.(message)
    reportRepositionChoices(run.decisions)
  }
  // Timing only: the program kept is emitted again by the caller, with its own lines.
  const programMs = (result: FeatureResult): number => {
    const warn = console.warn
    console.warn = () => {}
    try {
      const moves = withOperatorNotices(undefined, () => emitFeature(result, ctx))
      return estimateRuntimeMs(moves, model.rapidRate, ctx.feeds.fastTraverseRate, ctx.feeds.finishRate)
    } finally { console.warn = warn }
  }
  // An alternative that would win without the gap-fill charge, cheapest first, one per route.
  const unsettled = (d: RepositionChoiceTrace): string[] => {
    const bare = [
      { rung: 'lift', points: null as { x: number; y: number }[] | null, ms: d.liftMs - (d.liftCoverMs ?? 0) },
      ...d.candidates.filter(c => c.points.length >= 2 && c.outcome !== 'refused').map(c => ({ rung: c.rung, points: c.points, ms: c.ms + (c.coverMs ?? 0) })),
    ]
    const chosen = bare.find(o => o.rung === d.chosen)
    if (!chosen) return []
    const seen = new Set<unknown>([chosen.points ?? 'lift'])
    return bare.filter(o => o.ms < chosen.ms - 1e-6).sort((p, q) => p.ms - q.ms)
      .filter(o => { const key = o.points ?? 'lift'; if (seen.has(key)) return false; seen.add(key); return true })
      .map(o => o.rung)
  }
  const base = plan([], false)
  const open = base.decisions.map(d => ({ d, alternatives: unsettled(d) })).filter(o => o.alternatives.length > 0)
  if (open.length === 0) { report(base); return base.result }
  let best = base
  let bestMs = programMs(base.result)
  let bestForced: Forced[] = []
  for (const { d, alternatives } of open) {
    for (const rung of alternatives) {
      const forced = [...bestForced, { connStart: d.connStart, connEnd: d.connEnd, rung }]
      // Each plan is one long synchronous run; let the worker answer its messages between them.
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      let trial: Run
      try { trial = plan(forced, true) } catch { continue }
      if (trial.decisions.find(k => same(k.connStart, d.connStart) && same(k.connEnd, d.connEnd))?.chosen !== rung) continue
      const ms = programMs(trial.result)
      if (ms < bestMs - 1e-6) { best = trial; bestMs = ms; bestForced = forced; break }
    }
  }
  restoreFeatureStats(best.stats)
  report(best)
  return best.result
}

/** The depth levels emitFeature cuts: topZ down to the rough bottom in stepdown bites,
 *  then the floor-finish depth when it lies below that. */
function scheduledDepths(schedule: DepthSchedule): { depths: number[]; floorAppended: boolean } {
  const stepdown = Math.max(schedule.stepdown, 0.1)
  const depths: number[] = []
  let z = schedule.topZ
  let guard = 0
  while (z > schedule.roughBottomZ + 1e-6 && guard++ < 2000) {
    z = Math.max(z - stepdown, schedule.roughBottomZ)
    depths.push(z)
  }
  const floor = schedule.floorFinishDepth
  const floorAppended = floor !== undefined && depths.length > 0 && floor < schedule.roughBottomZ - 1e-6
  if (floorAppended) depths.push(floor)
  return { depths, floorAppended }
}

/**
 * WO-1579. Where workholding reaches into the Z range the cutter sweeps, its footprint -
 * grown by the Shank clearance - is taken out of each feature like an island, so the
 * clearing routes around a clamp and clears everything else; a strap across a region
 * splits it into features of its own. No workholding in reach returns the features
 * untouched, one run each over the operation's own heights. The worker's reach trim
 * still runs on the moves.
 *
 * WO-1623. The footprint is taken out only at the depths that reach it (WO-1618's
 * workholdingDepthBands): each feature is cut in bands, each planned on its own region
 * over its own depth range, so a vise under a through region leaves the region cleared
 * in full down to just above the vise top.
 */
async function featureRunsAroundWorkholding(
  features: LocalFeature[],
  payload: ACWorkerPayload,
  schedule: DepthSchedule,
  notify: ((message: string) => void) | undefined,
): Promise<FeatureRun[]> {
  const untouched = (): FeatureRun[] => features.map(feature => ({ feature }))
  const reach = payload as ACWorkerPayload & ToolReachInputs
  if (!reach.workholding || reach.workholding.length === 0) return untouched()
  const { depths, floorAppended } = scheduledDepths(schedule)
  if (depths.length === 0) return untouched()
  await ensureClipperReady()
  const allowanceMm = clearanceAllowanceMmOf(reach)
  const depthBands = workholdingDepthBands({
    meshes: reach.workholding, depths, topZ: schedule.reachTopZ, allowanceMm,
  })
  if (depthBands.every(band => band.keepOuts.length === 0)) return untouched()

  const runs: FeatureRun[] = []
  for (const feature of features) {
    const bands: { depths: number[]; pieces: LocalFeature[]; removedAreaMm2: number; addedFloorZ?: number }[] = []
    for (const depthBand of depthBands) {
      const reduced = featureAroundKeepOuts(feature, depthBand.keepOuts)
      const removedAreaMm2 = reduced?.removedAreaMm2 ?? 0
      const above = bands[bands.length - 1]
      // A floor added for a footprint that takes nothing more out of THIS feature is dropped.
      if (above && Math.abs(above.removedAreaMm2 - removedAreaMm2) <= 1e-3) {
        if (above.addedFloorZ !== undefined) above.depths.pop()
        above.depths.push(...depthBand.depths)
        above.addedFloorZ = depthBand.addedFloorZ
        continue
      }
      bands.push({
        depths: [...depthBand.depths],
        pieces: reduced ? reduced.pieces : [feature],
        removedAreaMm2,
        addedFloorZ: depthBand.addedFloorZ,
      })
    }
    const last = bands[bands.length - 1]
    if (last.addedFloorZ !== undefined) {
      last.depths.pop()
      delete last.addedFloorZ
    }

    let bandTopZ = schedule.topZ
    for (let bi = 0; bi < bands.length; bi++) {
      const band = bands[bi]
      const bandBottomZ = band.depths[band.depths.length - 1]
      const above = bi > 0 ? bands[bi - 1] : undefined
      if (above?.addedFloorZ !== undefined) {
        notify?.(
          `Adaptive Clearing: over the workholding the cut stops ${allowanceMm} mm above its top, so the last ` +
          `${formatMm(above.addedFloorZ - bandBottomZ)} mm of the depth was not cut there; ` +
          'everything above it is cleared.',
        )
      }
      // The footprint only grows with depth, so every band below this one is under it too.
      if (band.pieces.length === 0) {
        if (above) break
        notify?.(workholdingIslandNotice('Adaptive Clearing', band.removedAreaMm2, allowanceMm))
        notify?.('Adaptive Clearing: the whole region sits under the workholding, so there was nothing to cut.')
        break
      }
      if (band.removedAreaMm2 > 0) {
        notify?.(workholdingIslandNotice('Adaptive Clearing', band.removedAreaMm2, allowanceMm))
      }
      let bottomZ = bandBottomZ
      let floorFinish = false
      if (bi === bands.length - 1 && schedule.floorFinishDepth !== undefined) {
        // The floor-finish replay belongs to the last band; with no rough depth of its own
        // left, the band cuts to the floor as a plain level.
        const rough = floorAppended ? band.depths.slice(0, -1) : band.depths
        if (rough.length > 0) {
          bottomZ = rough[rough.length - 1]
          floorFinish = true
        }
      }
      for (const piece of band.pieces) runs.push({ feature: piece, topZ: bandTopZ, bottomZ, floorFinish })
      bandTopZ = bandBottomZ
    }
  }
  return runs
}

/** The feature less the keep-outs, split into pieces; null when no keep-out touches it. */
function featureAroundKeepOuts(
  feature: LocalFeature,
  keepOuts: readonly Loop[],
): { pieces: LocalFeature[]; removedAreaMm2: number } | null {
  if (keepOuts.length === 0) return null
  const { origin } = feature
  const boundary = signedArea(feature.boundary) > 0 ? feature.boundary : [...feature.boundary].reverse()
  const holes = (feature.holes ?? []).map(hole => (signedArea(hole) > 0 ? [...hole].reverse() : hole))
  const reduced = reduceRegionAroundKeepOuts(
    [boundary, ...holes],
    keepOuts.map(loop => toLocalLoop(loop, origin)),
  )
  if (!reduced) return null
  const outers = reduced.loops.filter(loop => signedArea(loop) > 0)
    .sort((a, b) => signedArea(a) - signedArea(b))
  const pieces = outers.map(loop => ({ boundary: loop, holes: [] as Loop[], origin }))
  for (const hole of reduced.loops.filter(loop => signedArea(loop) <= 0)) {
    // Smallest containing outer first (outers are sorted by area).
    const owner = pieces.find(piece => pointInPolygon(hole[0], piece.boundary) >= 0)
    owner?.holes.push(hole)
  }
  return { pieces, removedAreaMm2: reduced.removedAreaMm2 }
}

function formatMm(mm: number): string {
  return String(Number(mm.toFixed(2)))
}

function toLocalLoop(loop: Loop, origin: FeatureOrigin): Loop {
  if (origin.x === 0 && origin.y === 0) return loop
  return loop.map(point => ({
    x: point.x - origin.x,
    y: point.y - origin.y,
  }))
}

function toLocalFeature(boundary: ClassifiedLoop, holes: Loop[]): LocalFeature {
  const { localLoop, origin } = boundary
  return {
    boundary: localLoop,
    holes: holes.map(loop => toLocalLoop(loop, origin)),
    origin,
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback
}
