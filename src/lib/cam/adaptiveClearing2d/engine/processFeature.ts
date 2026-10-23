// SPDX-License-Identifier: LGPL-2.1-or-later
// Ported from FreeCAD's Adaptive2d (src/Mod/CAM/libarea/Adaptive.cpp and Path Adaptive Python), Copyright (c) 2018 Kresimir Tusek.
// This file remains under LGPL-2.1-or-later; the LienCAM project as a whole is distributed under GPL-3.0-or-later (see /LICENSE).
// The core adaptive-clearing pass loop for ONE feature (an outer boundary plus its
// holes). Port of FreeCAD ProcessFeature.Execute, in mm (no SCALE_FACTOR).
//
// Flow:
//   1. cut_region = feature offset inward by (toolRadius + finishStock); the tool
//      CENTRE must stay inside it (so the tool never gouges past the wall).
//   2. findStartPoint = the largest inscribable spot -> helix centre; seed `cleared`
//      with the helix-bored disk.
//   3. Repeatedly run a PASS: from an engage point, step forward holding the optimal
//      cut-area-per-distance (steering.findNextPoint), smoothing the heading with a
//      5-sample gyro, shrinking the step in tight turns / near walls, ramping the
//      target down near the boundary, until the tool reaches the wall / over-cuts /
//      stops cutting. Union the swept area into `cleared`.
//   4. Between passes, walk the boundary (engagementPoint) to the next remaining
//      material. A full lap with nothing left => feature cleared.
//
// Units note (load model, not raw lengths): the engage-band thresholds are derived
// from optimalCutAreaPerDist x moveDistance (an AREA), since FreeCAD's scaled
// "moveDistance*2" was a scaled-area value, not a length.

// WO-3018: every sampling, steering, sharpening and cap number comes from the policy record.
import { ADAPTIVE_POLICY as AP, adaptiveEngageMoveDistance } from '../../../../kernel/ops/adaptive/policy'
// (separate line: WO-3018's record test pins the import above verbatim)
import { ADAPTIVE_MOTION_SWITCHES, STEERING_SMOOTHING, adaptiveKeepDownCapPolicy } from '../../../../kernel/ops/adaptive/policy'
import type { AdaptiveMillingDirection } from '../../types'
import { materialSideFor } from '../../millingDirection'
import {
  type Pt, type Loop, type Loops, type PolyNode,
  offsetClosed, offsetClosedTree, union, intersection, difference, totalArea, netArea, capsulePath, diskPath, loopArea, offsetOpenRound, capsuleSweep,
} from './clipperEngine'
import { createToolGeometry } from './toolGeometry'
import { createStepper, type StepperOptions } from './steering'
import { boundedCleanPath } from './boundedCleanPath'
import { createEngagementWalker, boundaryArcsBetween } from './engagementPoint'
import { getEngagePoint } from './engagePoint'
import { buildWallFollowExit, buildWallFollowEntry, buildWallFollowThrough, type WallFollowRide } from './wallCleanLoop'
import { buildAcceptedLoopback } from './loopbackFillet'
import { operatorNotice } from './operatorNotices'
import {
  normalize, sumv, magnitude, sub, rotate, centroid, closestPointOnPaths, closestOnSegment, segmentPathsIntersection, cleanPath, closePath, polyBBoxOf,
} from './geom'
import { estimatePassesMs, estimateRepositionMs, estimateWallGapMs, repositionLevelCount, ridePasses, type RepositionTimeModel } from './repositionTime'

// PROTO wall-clean instrumentation (render-only): counts how many inter-pass transitions
// fired the wall-clean ride vs the total transitions seen, so a dump can report the
// fraction. Reset at the top of each processFeature run.
const wallCleanStats = { fired: 0, transitions: 0 }
export function getWallCleanStats(): { fired: number; transitions: number } { return { ...wallCleanStats } }

// B8 stay-down engagement-gate instrumentation (measurement-only; does NOT affect emitted
// geometry). `rejections` counts how often the integral-wall-follow B8 gate rejects a
// candidate stay-down ride and concedes a retract (rung c). `routedAround` counts how often
// rung (b)(1) recovered such a rejection by keeping down on the ALTERNATE boundary arc, and
// `routedAroundChord` counts how often rung (b)(2) recovered it on the through-cleared straight
// chord (when no boundary arc kept the ride down -- both arcs slot, or the endpoints share no
// wall at all). Reset at the top of each processFeature run, like wallCleanStats. A retract that
// rung (b) recovered (arc OR chord) is NOT counted in `rejections` (only genuine concede-the-
// lift cases are): every eliminated lift equals exactly one routedAround + routedAroundChord.
// `routedDetour` (WO-438) counts the two tier-1 rungs this WO added: (b)(3) the same wall ride
// rung (a) offers, retried under the ancestor's keepToolDownDistRatio DETOUR budget instead of
// the wall-follow length factor; and (b)(4) a MULTI-SEGMENT at-depth route through proven-
// cleared stock (backtrack along the cutter's own track, a perpendicular detour, or a ride
// through the swept-track graph) that recovered a connection no single arc or chord kept down.
// `routedWallChain` (WO-2787) counts rung (b)(6): a connection between two DIFFERENT walls kept
// down by riding both walls in the milling direction.
const b8GateStats = { rejections: 0, routedAround: 0, routedAroundChord: 0, routedDetour: 0, stoppedShort: 0, routedWallChain: 0 }
export function getB8GateStats(): { rejections: number; routedAround: number; routedAroundChord: number; routedDetour: number; stoppedShort: number; routedWallChain: number } { return { ...b8GateStats } }

// WO-447 WALL-COVERAGE bookkeeping (measurement + evidence; the RIDES it reports are real,
// the counters are not read by any gate). Under params.wallFinish the engine parameterizes
// every cutRegion loop by arc length and records which spans the wall-follow transition
// rides actually covered; after the walk exhausts it rides the uncovered spans so the wall
// is ridden ONCE, WHOLE. These counters let the corpus harness prove Operator's promise that
// only the MISSED fraction gets ridden:
//   boundaryLen  -- total arc length of the cutRegion loops offered to gap-fill (mm)
//   coveredLen   -- of that, the length the transition rides had already ridden (mm)
//   filledLen    -- of the remainder, the length actually ridden by gap-fill rides (mm)
//   orderedGapConnectionLen / filledGapConnectionLen -- direct between-ride travel in the
//      historical loop/arc candidate order vs the ORDER ACTUALLY EMITTED (WO-451). Both are
//      measured after the fact, off the rides the guards accepted; they are the outcome, not
//      the input to the WO-460 choice below.
//   gapOrderOrderedPlanLen / gapOrderNearestPlanLen -- WO-460's up-front score of BOTH
//      candidate orders over the SAME fixed candidate set (between-ride straight hops)
//   gapOrderShorterPlan / gapOrderChoice -- which order those two scores prefer, and which
//      order the engine actually emitted. They are NOT the same field on purpose: the hop
//      score is a proxy and the corpus proves where it is wrong. See the WO-460 block at the
//      gap-fill emission loop.
//   skippedShort -- gaps below the named epsilon (max(tolerance, 2*arcTol)), not ridden
//   skippedEmpty -- gaps whose corridor removes nothing measurable, not ridden
//   refusedApproach / refusedOverload / refusedDirection -- LOUD refusals (see stats.aborted)
// Reset at the top of each processFeature run, like wallCleanStats.
/** WHICH gap-fill emission order WO-460's up-front score chose. 'none' = the gap-fill block
 *  did not run, or had fewer than two candidates, so there was no order to choose. */
export type GapOrderChoice = 'nearest-first' | 'historical' | 'none'
const wallCoverStats = {
  boundaryLen: 0, coveredLen: 0, filledLen: 0, gaps: 0, filled: 0,
  orderedGapConnectionLen: 0, filledGapConnectionLen: 0,
  gapOrderOrderedPlanLen: 0, gapOrderNearestPlanLen: 0,
  gapOrderShorterPlan: 'none' as GapOrderChoice,
  gapOrderChoice: 'none' as GapOrderChoice,
  skippedShort: 0, skippedEmpty: 0, refusedApproach: 0, refusedOverload: 0, refusedDirection: 0,
}

/** WO-460 EVIDENCE HOOK, NOT A PRODUCT SWITCH. The retract columns Operator asked for
 *  ("optimize away retracts when possible", card
 *  Q-WALL-COVERAGE-IS-COMPLETE-YOUR-O-1787267481847) cannot be predicted before emission --
 *  a clearance retract is the tier ladder's verdict, and the ladder only speaks while
 *  appending. So the evidence harness runs the SAME feature twice, forcing each order, and
 *  reads the real counts off the two pass streams. Default null = the engine chooses, which
 *  is the only state any product caller ever sees. */
let gapOrderOverride: GapOrderChoice | null = null
export function setGapOrderOverride(order: GapOrderChoice | null): void {
  gapOrderOverride = order === 'none' ? null : order
}
export type WallCoverStats = typeof wallCoverStats
export function getWallCoverStats(): WallCoverStats { return { ...wallCoverStats } }

// WO-464 measurement-only record for re-seed components that cannot accept even the
// engine's smallest legal descent helix. The motion decision is made from the existing
// MIN_DESCENT_HELIX_RADIUS authority below; this record only makes the resulting leftover
// measurable without adding fields to the byte-stability-pinned pass stream.
export interface DroppedSliverStats {
  largestEntryRadius: number | null
  regions: { toolCentreArea: number; sweptArea: number; stage: DroppedSliverStage; largestEntryRadius: number }[]
}
/** WHERE the engine declined the component. 'cut-region' is WO-465's prevention -- the
 *  component was never made a region at all. 're-seed' is WO-464's buffer -- the walk had
 *  already started and the leftover it was about to seed could not accept a legal descent.
 *  Both leave the material standing in the honest residual; only the moment differs. */
export type DroppedSliverStage = 'cut-region' | 're-seed'
const droppedSliverStats: DroppedSliverStats = { largestEntryRadius: null, regions: [] }
export function getDroppedSliverStats(): DroppedSliverStats {
  return {
    largestEntryRadius: droppedSliverStats.largestEntryRadius,
    regions: droppedSliverStats.regions.map(region => ({ ...region })),
  }
}

// WO-439 STEP 1 FRAGMENTATION CENSUS (diagnosis only; motion-neutral by construction).
// Records WHY every cut pass ended and WHY every re-seed happened, so the fragmentation
// (Bar: 7 entries where the reference path needs 1) can be attributed mechanically to named causes.
//
// WHY MODULE-LEVEL AND OPT-IN, not a field on AdaptivePass: _bytestab-fingerprint.test.ts
// hashes JSON.stringify({ startPoint, entries, passes }); ANY enumerable field added to the
// pass stream moves those hashes (the WO-435 liftReason precedent had to be documented as
// additive-and-ignored for exactly this reason). A module-level sink is invisible to the
// hash. It is also OFF by default so the remaining-material probes (two clipper ops per
// pass end) cost nothing in normal runs and on CI.
//
// NOTHING in this block feeds back into a decision: every recorder is a pure write into
// `fragCensus`, guarded by `fragCensus.enabled`. The engine reads none of it.
export interface PassEndRecord {
  /** 0-based ordinal of the pass in this run's pass loop (kept or dropped). */
  pass: number
  /** Why the per-point loop stopped. See WO-439 report for the ancestor-vs-ours split. */
  reason:
    | 'boundary-clip'      // ANCESTOR: the clipped step left the region -> pass ends at the wall
    | 'boundary-stall'     // OURS: the clip degenerated to no move, the tangential skim was refused
    | 'no-cut'             // ANCESTOR: the stepper found no direction that removes material
    | 'over-cut'           // ANCESTOR: a step's load exceeded 2 x optimal
    | 'orbit-close'        // OURS: the pass returned to its engage point / a previously visited cell
    | 'max-points'         // OURS: MAX_POINTS_PER_PASS exhausted
  /** Extra mechanical detail for the reason (skim verdict, orbit flavour, load numbers). */
  detail: string
  /** Tool centre where the pass ended. */
  x: number
  y: number
  /** Distance from that point to the cut-region boundary (tool-centre space), mm. */
  distToBoundary: number
  /** Path length the pass travelled, mm. */
  travel: number
  /** Material the pass removed, mm^2 (cumulativeCuttingArea). */
  area: number
  points: number
  /** Was the pass emitted at all (keepPass)? */
  kept: boolean
  /** WO-410 progress contract: did it clear at least one engage-band bite (minPassBite)? */
  progressed: boolean
  /** minPassBite for this run, mm^2 (the bar `area` had to clear to count as progress). */
  minPassBite: number
  /** Uncut material still standing within ONE TOOL DIAMETER of the end point, mm^2,
   *  measured AFTER this pass's own corridor is folded into `cleared`. > 0 on a 'no-cut'
   *  ending means the break was a belief artefact, not an empty neighbourhood. -1 when
   *  the probe was not run. */
  remainingNearEnd: number
  /** Same neighbourhood, eroded by half a stepover: material THICKER than the finishing
   *  rim (the reseed's own "thick" test). > 0 means real, tool-takeable stock was left. */
  remainingNearEndThick: number
}
export interface ReseedRecord {
  /** Pass ordinal after which the walker gave up. */
  pass: number
  /** Why the engage walker stopped offering points. */
  cause:
    | 'walk-exhausted'   // ANCESTOR: moveForwardToCutThreshold walked the whole boundary twice, no in-band bite
    | 'fruitless-lap'    // OURS (WO-410): a full boundary lap of in-band bites with no PROGRESSING pass
  /** Boundary distance the walker covered since the last progressing pass, mm. */
  odometerSinceProgress: number
  /** Total length of the boundary loops this walker walks, mm. */
  boundaryLength: number
  /** In-band bites the walker DID find and hand to a pass since the last progressing pass. */
  bitesSinceProgress: number
  /** What reseed() then did. */
  outcome: 'side' | 'interior' | 'stop'
  /** reseedStop when outcome is 'stop'. */
  stop?: 'complete' | 'no-progress' | 'no-entry'
  /** Where the new entry landed (outcome side/interior). */
  x?: number
  y?: number
  /** Uncut material still standing in the whole region at this moment, mm^2. */
  remainingArea: number
}
export interface FragmentationCensus {
  enabled: boolean
  passEnds: PassEndRecord[]
  reseeds: ReseedRecord[]
  /** Every entry the run planted, in order (the initial one first). */
  entries: { pass: number; x: number; y: number; mode: 'helix' | 'plunge' | 'side'; radius: number }[]
}
const fragCensus: FragmentationCensus = { enabled: false, passEnds: [], reseeds: [], entries: [] }
/** Turn the WO-439 diagnosis recorder on/off. OFF by default; diagnostic tests only. */
export function setFragmentationCensus(on: boolean): void { fragCensus.enabled = on }
/** The census from the most recent processFeature run (empty when disabled). */
export function getFragmentationCensus(): FragmentationCensus {
  return { enabled: fragCensus.enabled, passEnds: [...fragCensus.passEnds], reseeds: [...fragCensus.reseeds], entries: [...fragCensus.entries] }
}

/** WO-2787: what the keep-down ladder saw when a connection lifted -- the engine's own
 *  pre-move stock belief and the machinable region -- so a diagnostic can draw the lift.
 *  OFF (null) by default; diagnostic tests only. Read-only: nothing it returns is used. */
export interface KeepDownLiftTrace {
  passIndex: number
  connStart: Pt
  connEnd: Pt
  liftReason: string
  clearedBeforePass: Loops
  cutRegion: Loops
}
let keepDownLiftTrace: ((t: KeepDownLiftTrace) => void) | null = null
export function setKeepDownLiftTrace(fn: ((t: KeepDownLiftTrace) => void) | null): void { keepDownLiftTrace = fn }

/** WO-2787 fix round 4: every candidate the time-chosen keep-down ladder weighed for one
 *  connection, its estimated machine time over all depth levels, and what became of it.
 *  OFF (null) by default; diagnostic tests only. Read-only: nothing it returns is used. */
export interface RepositionChoiceTrace {
  passIndex: number
  connStart: Pt
  connEnd: Pt
  liftMs: number
  /** A refused rung with nothing to time (no route found, stop-short refused) has no points
   *  and ms 0; `reason` says why. */
  candidates: { rung: string; kind: 'wallfollow' | 'loopback'; points: Pt[]; feedFrom?: number; ms: number; outcome: 'feasible' | 'refused' | 'slower'; reason?: string; coverMs?: number }[]
  chosen: string
  /** WO-2787 round 7: the gap-fill time inside `liftMs` (the wall a kept-down ride would have
   *  covered and the lift leaves to the gap-fill); a candidate's `coverMs` is the gap-fill time
   *  its ride spares, already taken off its `ms`. */
  liftCoverMs?: number
  /** WO-2787 round 7: the rung was forced (the whole-program check kept a program planned
   *  with it, or a diagnostic hook asked for it), not ranked by the model. */
  forced?: true
  clearedBeforePass: Loops
  cutRegion: Loops
}
let repositionChoiceTrace: ((t: RepositionChoiceTrace) => void) | null = null
export function setRepositionChoiceTrace(fn: ((t: RepositionChoiceTrace) => void) | null): void { repositionChoiceTrace = fn }
/** WO-2787 fix round 7: the whole-program check (engine/index.ts) hands the trace the
 *  decisions of the program it kept, once, instead of every plan it timed. */
export function reportRepositionChoices(decisions: RepositionChoiceTrace[]): void { for (const t of decisions) repositionChoiceTrace?.(t) }
/** WO-2787 fix round 7: OFF (null) by default; diagnostic tests only. Asked once per connection
 *  the timed ladder decides; a rung name ('lift' for the lift) makes that connection take that
 *  rung if it proves, so a test can emit the whole program with each admitted alternative and
 *  time it. null decides as usual. */
let repositionChoiceForce: ((connStart: Pt, connEnd: Pt) => string | null) | null = null
export function setRepositionChoiceForce(fn: ((connStart: Pt, connEnd: Pt) => string | null) | null): void { repositionChoiceForce = fn }
/** WO-2787 fix round 7: the per-run counters (B8 gate, wall cleanup, wall coverage, dropped
 *  slivers) as one value, so the whole-program check (engine/index.ts) can leave them
 *  describing the run it keeps rather than the last trial it timed. */
export type FeatureStatsSnapshot = { b8: typeof b8GateStats; clean: typeof wallCleanStats; cover: typeof wallCoverStats; sliver: DroppedSliverStats }
export function snapshotFeatureStats(): FeatureStatsSnapshot {
  return { b8: { ...b8GateStats }, clean: { ...wallCleanStats }, cover: { ...wallCoverStats }, sliver: getDroppedSliverStats() }
}
export function restoreFeatureStats(snapshot: FeatureStatsSnapshot): void {
  Object.assign(b8GateStats, snapshot.b8)
  Object.assign(wallCleanStats, snapshot.clean)
  Object.assign(wallCoverStats, snapshot.cover)
  droppedSliverStats.largestEntryRadius = snapshot.sliver.largestEntryRadius
  droppedSliverStats.regions = snapshot.sliver.regions.map(region => ({ ...region }))
}

/** A tool entry into fresh material: a helix ramp (radius > 0) or a straight plunge
 *  (radius 0, only used where a helix will not fit). Every region -- the initial one
 *  AND each re-seeded pocket -- gets one, so Phase 5 ramps each entry instead of
 *  plunging blindly. */
// 'side' = opt-in outside-in lateral entry over a pre-cleared exterior (clearedSeed).
// clearPoint is the fully-clear descent centre; point is the bounded grazing engage centre.
export interface AdaptiveEntry { point: Pt; clearPoint?: Pt; radius: number; mode: 'helix' | 'plunge' | 'side' }

export type AdaptivePass =
  | { type: 'cut'; points: Pt[] }
  | { type: 'lead'; points: Pt[] }
  // 1 = keep down (cleared), 2 = lift; boundarySpan = recovered wall-follow span (inert, Phase A).
  // helixDescent (jumpType 2 only): the landing disk is mostly UNCUT (early-job raw walker
  // landing), so emit must descend via a helix ramp at `center` (radius `radius`, the same
  // construction as an entry) instead of a straight full-width plunge, then lead at depth to
  // points[1]. Planned by the lift-landing gate (planHelixDescent); |center - points[1]| <=
  // radius, so the lead stays inside the disk the helix itself opens.
  // fallbackHelix (jumpType 2 only, opt-in via ProcessParams.liftFallbackHelix): a helix that
  // FITS at the landing (same construction as helixDescent) offered for the emitter's judgement
  // when the planner's own gate ACCEPTED a straight descent. The 3D rougher replays live carved
  // stock (WO-400): if that stock disagrees with the planner's polygon model about the landing
  // shaft, the emitter descends via this helix instead of throwing the whole operation away.
  // liftReason (jumpType 2 only, WO-435 T1 attribution): names which cheaper tiers were
  // tried and why each failed before conceding the retract -- e.g. 'plow@(x,y)',
  // 'gouge@(x,y)', 'plow@(x,y)+no-wall+chord-overload', 'keepdown-overload@(x,y) w=..>cap=..'.
  // ADDITIVE ONLY: emit ignores this field; it changes no motion. Always set on every
  // jumpType-2 link this file constructs (an absent value on a jumpType-2 link is a bug).
  // microLift (jumpType 2 only, WO-437 tier 2, GOOD-SPEC.md section 3): set when this
  // link's direct corridor (points[0] -> points[1]) is proven clear at FULL tool width
  // against clearedBeforePass -- the SAME proof tier 1's rungs use, not a loosened one.
  // `z` is the ADDITIVE offset (LIFT_DISTANCE) emit.ts adds to the level's passEndDepth to
  // get the hover height for the two horizontal-clearance rapids; it does not touch the
  // gated landing descent (helixDescent/plunge) at all. ADDITIVE + ignored-when-absent: a
  // link this file constructs without it keeps today's full-clearance behavior unchanged.
  // clearAirLanding (jumpType 2 only, WO-1091): this link's landing point (points[1]) was
  // taken from CLEARED AIR beside the requested landing and proved to the SIDE ENTRY'S OWN
  // bound -- landingDiskUncutFraction <= SIDE_RESEED_CLEAR_UNCUT_MAX, the whole cutter disk
  // standing in air, the strictest proof in the gate. The descent shaft therefore contains no
  // stock at all, so emit descends it as a RAPID and engages with the following `lead` pass at
  // leadInRate -- the exact motion a side entry already emits (emit.ts emitEntry, mode 'side':
  // rapid over the clear point, rapid down through air, feed in at leadInRate). Set ONLY by
  // planGatedLanding's clear-air rung; a link without it keeps today's plunge-at-plungeRate
  // descent unchanged, because its shaft was proven only to the looser landingUncutCap.
  | { type: 'link'; points: [Pt, Pt]; jumpType: 1 | 2; boundarySpan?: Pt[]; helixDescent?: { center: Pt; radius: number }; fallbackHelix?: { center: Pt; radius: number }; liftReason?: string; microLift?: { z: number; empty?: true }; clearAirLanding?: true }
  | { type: 'wallfollow'; points: Pt[] } // integral wall-follow: rides the shared wall at depth in place of a lift (replaces a jumpType-2 link)
  // A loopback pass has TWO producers, and they answer to different quality rules: the
  // wall-clean FILLET chain built in appendCutPass (must join its neighbouring wall rides
  // tangentially) and WO-438's ROUTED KEEP-DOWN traverse (rung (b)(2)'s through-cleared chord,
  // rung (b)(4)'s backtrack/detour route -- a rapid that AC-SPEC E.3 ALLOWS to backtrack along
  // the cutter's own just-cut track, an exact 180deg turn by construction). The discriminator
  // is `FeatureResult.routedLoopbackPassIndices` and is deliberately NOT a field here: the two
  // shapes are emitted identically (fast_traverse at depth over proven-clear stock), so putting
  // it in the pass object would move the pass-stream fingerprint of every fixture that has a
  // routed ride WITHOUT moving one coordinate (WO-1069 audit, attempt 1: fix6 Triangle).
  | { type: 'loopback'; points: Pt[] } // wall-clean loopback (fillet -> fast-traverse -> fillet) over CLEARED stock; emitted as fast_traverse moves at depth
  | { type: 'entry'; point: Pt; clearPoint?: Pt; radius: number; mode: 'helix' | 'plunge' | 'side' }
  | { type: 'finish'; points: Pt[] } // dedicated wall-finishing contour (wallFinish feature): stops stockToLeave off the wall (WO-450; 0 radial stock only under wallFinishToNet); depth-gated in emit by wallFinishMode

/** WO-1069: which emitted `loopback` passes came from WO-438's ROUTED KEEP-DOWN producer
 *  (`pushConnectionRide`) rather than from the wall-clean fillet builder. Recorded against the
 *  pass OBJECT, never inside it, and published on the result as an index list -- see
 *  `FeatureResult.routedLoopbackPassIndices`. A WeakSet because the marking happens deep in
 *  `appendCutPass` (which is handed the shared `passes` array, not the result) and must not
 *  extend that function's already-enormous parameter list or keep any pass alive. */
const ROUTED_LOOPBACKS = new WeakSet<object>()

/** WO-449: THE GATED CONNECTION INTO ONE WALL-FINISH LAP.
 *
 *  THE DEFECT THIS EXISTS TO KILL (Operator, simulator, 2026-08-23, SquareIsland move 6849):
 *  the wallFinish stack can emit MULTIPLE finish contours (outer wall + island wrap) and
 *  emit strung them together with NOTHING between -- the first move of each contour was a
 *  plain feed at depth, so the connection ran STRAIGHT ACROSS whatever lay between, on
 *  SquareIsland through the RETAINED ISLAND at finishing feed. The same bare feed carried
 *  the tool from the last roughing position into the FIRST lap. R1-class.
 *
 *  THE TIER TAKEN (GOOD-SPEC section 3): tier 3, a full clearance retract with a GATED
 *  descent, for every finish connection. Attribution is mandatory and `reason` carries it,
 *  with BOTH bars measured on the direct corridor: the gouge veto plus the sustained-load
 *  proof (centrePathExitsCutRegion + rideOverloadsUncut at 1.5 x stepover -- the SAME proof
 *  tier 1's rungs and WO-437's micro-lift are held to), AND, where that one passes, the mm^2
 *  of belief-uncut the corridor would actually sweep, which is the bar T5 sets for anything
 *  moving at traverse speed. Measured on the nine-fixture corpus at matched settings, every
 *  finish connection fails at least one of them: four sweep the retained model or plough
 *  standing stock outright, and the rest are load-clear but still end INSIDE belief-uncut,
 *  because a finish lap starts against standing stock -- the tolerance / 2 skin at its own
 *  offset (WO-450), or the whole finishStock skin on the true wall under wallFinishToNet --
 *  a place no roughing pass ever reached. Tier 3 is therefore not a shortcut here; it is the first
 *  tier whose proof passes. Where a cheaper tier could later apply is a real question for a
 *  follow-up -- a tier-1 travel that stops SHORT of the skin and hands the last stretch to a
 *  feed-rate lead would be provable -- and it needs T4's picture gate, not a defect fix.
 *
 *  THE DESCENT is planned by the engine's existing lift-landing gate (planGatedLanding) --
 *  no new gate math: descend on the lap's own start when its cutter disk is clear within
 *  LANDING_UNCUT_CAP, else at a proven-cleared point with a bounded tangent lead onto the
 *  lap, else via planHelixDescent. Its region context is the TRUE-WALL tool-centre region
 *  (finishFitRegion), because the lap rides closer to the wall than cutRegion reaches --
 *  by tolerance / 2 at the WO-450 default, by the whole finishStock under wallFinishToNet. A refusal is loud and the lap is dropped, never entered ungated. */
export interface FinishApproach {
  /** The tier this connection took. 'retract' is WO-449's tier 3 -- a flight to clearance
   *  and a gated descent. 'stopshort' is WO-466's tier 2.5, where the tool NEVER LEAVES THE
   *  FLOOR: it travels at depth over ground the proof clears (`travel`) and feeds the engaged
   *  tail into the standing skin (`feed`). `helix`/`lead`/`descent` describe a DESCENT and are
   *  therefore meaningless on tier 2.5 -- see the notes on each. */
  tier: 'retract' | 'stopshort'
  /** XY where the gated descent happens. Proven clear against the pre-move belief, or the
   *  point the planned helix opens. */
  descent: Pt
  /** Helix descent, when no proven-clear shaft plus bounded lead existed (same construction
   *  as a region entry; emit descends via emitHelixRamp). */
  helix?: { center: Pt; radius: number }
  /** At-depth lead from the descent point onto the lap's first cutting point. Absent when
   *  the descent lands directly on it. */
  lead?: Pt[]
  /** WO-1091: `descent` came from planGatedLanding's CLEAR-AIR rung -- the whole cutter disk
   *  proven standing in air at the side entry's own bound (SIDE_RESEED_CLEAR_UNCUT_MAX), not
   *  merely within the looser landingUncutCap. There is no stock in the shaft, so emit rapids
   *  down it instead of feeding at plungeRate. The lead itself already runs at leadInRate on
   *  every tier-3 approach, so this flag changes only the descent. */
  clearAirLanding?: true
  /** WO-1138 tier 2.5 ONLY: optional fed disengage from the current cut frontier to the first
   * point where the whole cutter is in cleared stock. */
  departure?: Pt[]
  /** WO-466 tier 2.5 ONLY: the at-depth traverse from where the tool physically stands to the
   *  point the zero-tolerance traverse proof clears. Two points; no lift and no descent. */
  travel?: Pt[]
  /** WO-466 tier 2.5 ONLY: the engaged tail, from the travel's end onto the lap's own start,
   *  at cutting feed and proven under the tier-0 cut-through caps. Two points. */
  feed?: Pt[]
  /** Index in the lap's polyline where cutting starts. Non-zero only where the gate's
   *  corner-fillet rung fired, which proves its own lead covers the skipped prefix; the lap
   *  is CLOSED, so its last point is the skipped head and the loop still closes. */
  cutStartIndex?: number
  /** T1 attribution (GOOD-SPEC section 6): which cheaper tiers were tried, which proof
   *  failed, and which rung of the descent gate answered. */
  reason: string
}

export interface Feature { boundary: Loop; holes?: Loop[] }

// Evidence-only observation hook. Production capture installs this around one saved
// operation so its exact adaptive requests can be replayed; normal product use leaves it null.
export type ProcessFeatureRequestRecorder = (request: { feature: Feature; params: ProcessParams }) => void
let processFeatureRequestRecorder: ProcessFeatureRequestRecorder | null = null
export function setProcessFeatureRequestRecorder(recorder: ProcessFeatureRequestRecorder | null): void {
  processFeatureRequestRecorder = recorder
}

/** Per-call, measurement-only view of a physically accepted graph candidate, before
 * caller selection/emission (landing callers may split it or choose another candidate).
 * Snapshots share no mutable objects with the planner; absent observers allocate none. */
export type AcceptedGraphRouteObserver = (route: {
  readonly points: readonly Readonly<Pt>[]
  readonly length: number
  readonly maxLength: number
}) => void

export interface ProcessParams {
  /** 3D model boundaries require cleanup bounded against the original samples.
   * Omitted keeps the established 2D pass stream and corner transitions. */
  boundedPathCleanup?: boolean
  /** 3D roughing: one load-bounded wall pass owns the wall band, without a
   * second tolerance-skin lap. Requires wallFinish; existing 2D callers omit it. */
  singleWallPass?: boolean
  toolRadius: number
  stepOver: number      // fraction 0..1 of tool DIAMETER
  tolerance: number     // mm
  helixDiameter: number // mm (entry helix diameter)
  /** Physical milling direction for a clockwise spindle. Missing is climb, the
   *  historical canonical-forward stream: material on the right of a pocket wall
   *  (WO-1896; the stream was mislabelled conventional before). */
  millingDirection?: AdaptiveMillingDirection
  stockToLeave?: number // mm radial finish stock
  arcTol?: number
  stepper?: StepperOptions
  /** Load setpoint: the steering's symmetric load search aims at `loadSetpoint * optimal`
   *  rather than optimal, so realized cutting load holds AT/under optimal smoothly (aiming
   *  exactly at optimal let the symmetric band overshoot ~40% of steps). Default 0.95.
   *  Internal MVP param -- not exposed in the UI. */
  loadSetpoint?: number
  /** Internal conservative-replan allowance for shallowly uncut lift landings.
   * Default 0.05. This changes entry handling only, never wall clearance. */
  landingUncutCap?: number
  /** Attach `fallbackHelix` to every jumpType-2 link the gate accepts as a straight descent
   *  (when a helix fits there). For emitters that hold live carved stock (the 3D rougher).
   *  Default OFF: the pass stream is byte-identical without it. */
  liftFallbackHelix?: boolean
  /** WO-3054: material-space loops (feature frame) that earlier operations already cleared
   *  down to the deepest level this feature is cut to -- a drilled, bored or milled hole. A
   *  plunge entry (helixDiameter under the descent floor) into a closed region goes straight
   *  down only where the whole tool disk stands inside one of them; anywhere else it enters
   *  with the default helix. Absent: no cleared hole is known. */
  clearedHoles?: Loops
  /** WO-3054 fix 1: the operator's minimum helix radius (emit's minHelixRadius). A helix entry
   *  is planned at least this wide, so emit never turns it into a plunge. Absent: no floor
   *  above the descent floor. */
  minHelixRadius?: number
  /** Integral wall-follow: replace a between-pass lift with a wall-skim at depth when its
   *  two endpoints share a boundary loop within a length budget. Default OFF (undefined =
   *  byte-identical to the lift-everywhere behavior). */
  integralWallFollow?: boolean
  /** Maximum direct wall-follow length as a multiple of its endpoint chord. Missing,
   *  non-finite, or non-positive values preserve the historical 2.0 budget. */
  integralWallFollowLengthFactor?: number
  /** Wall cleanup as we go (integrated finishing): at a wall-reaching inter-pass transition,
   *  emit a wall-follow exit -> tangent loopback -> wall-follow entry in place of the link,
   *  and SKIP the separate finishing-contour pass. Default OFF (false) = byte-identical. */
  wallCleanupAsWeGo?: boolean
  /** Loopback fillet radius as percent of tool radius (default 25). Resizes the wall-clean
   *  loopback/wall-follow fillet only; never changes whether a loopback or fillet is built. */
  loopbackFilletPct?: number
  /** When true, request a dedicated wall-finishing pass (consumed in a later commit).
   *  Default OFF (false). */
  wallFinish?: boolean
  /** WO-450 ESCAPE HATCH. Default FALSE: the wall-finish lap stops `stockToLeave` off the
   *  wall, so the operation's radial "stock to leave" survives the finish lap instead of
   *  being removed by it. TRUE restores the pre-WO-450 shape exactly -- the lap rides the
   *  TRUE wall (offset by toolRadius alone, 0 radial stock) and is credited the whole
   *  finishStock -- for the operator who wants the finish lap to go to size in one op and
   *  reads "stock to leave" as roughing-only.
   *
   *  NOT `wallFinishMode`, which is a DEPTH SCHEDULE ('final' | 'each_stepdown',
   *  emit.ts:47) and answers a different question. The user-facing name and label are
   *  Operator's call; nothing in the UI sets this yet. */
  wallFinishToNet?: boolean
  // Opt-in outside-in seed (FreeCAD Adaptive2d's caller-supplied `clearedPaths`). When
  // provided AND it abuts the machinable region (an open edge exists), the frontier grows
  // INWARD from this pre-cleared exterior region instead of outward from an interior helix
  // disk. Absent (or non-abutting => closed pocket) this is ignored and behaviour is
  // byte-identical to the interior-helix default.
  clearedSeed?: Loops
  /**
   * Skip the ordinary cleanup contour on positive-area outer boundaries. Used
   * by 3D full-stock roughing when that boundary is the open stock edge, not a
   * retained model wall. Island/hole contours are still cleaned normally.
   */
  skipOuterBoundaryCleanup?: boolean
  /** WO-2787 fix round 4: the machine-time model for choosing how a would-lift connection
   *  repositions (engine/index.ts builds it from the operation's feeds and heights). With it,
   *  the keep-down ladder weighs every candidate it can prove and the lift by estimated time
   *  and takes the fastest; a tie stays down. Absent: the ladder's first proven rung wins,
   *  byte-identical to the stream before it existed. */
  repositionTime?: RepositionTimeModel
}

export interface FeatureResult {
  startPoint: Pt | null
  entries: AdaptiveEntry[] // helix/plunge entries in order (initial first, then re-seeds)
  passes: AdaptivePass[]
  /** Geometric cleared side for each `finish` pass, in finish-pass order. Kept outside
   *  the pass objects so historical pass-stream fingerprints remain byte-identical. */
  finishClearedRegions?: ('inside' | 'outside')[]
  /** WO-445/WO-447/WO-450: which offset each `finish` pass rides, in finish-pass order.
   *  Since WO-447 there is exactly ONE offset -- 'wall', the wall-finish contour at
   *  toolRadius + wallFinishNearDepth, which takes only the skin standing between that
   *  contour and the roughing offset, i.e. `finishStock - wallFinishNearDepth`. WO-450 moved
   *  that contour OFF the true wall by default (wallFinishNearDepth = stockToLeave, so the
   *  skin it meets is tolerance / 2); under wallFinishToNet the depth is 0, the contour IS
   *  the true-wall contour at toolRadius and the skin is the whole finishStock, exactly as
   *  it was before WO-450. The member is still named 'wall' because it names the wall lap,
   *  not a fixed offset. WO-445's second member ('semi', a full second
   *  perimeter lap at the roughing offset) is GONE: the machining-load layer of the wall is
   *  now taken by the roughing wall-follow coverage (transition rides + WO-447 gap fills),
   *  which are 'wallfollow' passes, not finish passes, so they never appear here. The array
   *  is kept (rather than dropped) because it is the per-pass record the harness reads to
   *  prove the stack is one lap. Kept outside the pass objects for the same reason
   *  finishClearedRegions is: historical pass-stream fingerprints stay byte-identical. */
  finishPassOffsets?: ('wall')[]
  /** Complete tool-centre region bounded by every wall-finish loop. Lead fitting uses
   *  this outer-plus-islands context so a tangent arc cannot cross a neighboring wall. */
  finishFitRegion?: Loops
  /** WO-449: the GATED CONNECTION into each `finish` pass, in finish-pass order. One entry
   *  per finish pass; `undefined` only where no connection was needed. Kept outside the
   *  pass objects for the same reason finishClearedRegions is -- historical pass-stream
   *  fingerprints stay byte-identical. See FinishApproach. */
  finishApproaches?: (FinishApproach | undefined)[]
  /** WO-1069: indices into `passes` of every `loopback` pass emitted by WO-438's ROUTED
   *  KEEP-DOWN producer rather than by the wall-clean fillet builder. Ascending, and empty
   *  when the feature emitted none. Two producers share the `loopback` pass type because both
   *  are fast_traverse at depth over proven-clear stock, but only a FILLET chain owes its
   *  neighbours a tangent join -- a routed ride is a rapid AC-SPEC E.3 lets backtrack along the
   *  cutter's own just-cut track (an exact 180deg turn by construction). Kept OUTSIDE the pass
   *  objects for exactly the reason finishClearedRegions is: a discriminator that changes no
   *  coordinate must not move a pass-stream fingerprint. WO-438 became the second producer of
   *  this type in 2026-08 with no discriminator at all, which is why the loopback-fillet guard
   *  has read its 177-180deg backtracks as non-tangent fillets since 136306bf (WO-1061
   *  attribution: the WO-439..447 batch). */
  routedLoopbackPassIndices?: number[]
  cleared: Loops
  cutRegion: Loops
  residual: Loops // uncut material left inside the target region (targetRegion - cleared)
  stats: {
    passes: number; points: number; cacheHits: number; cacheMisses: number; aborted?: string
    // honest gap measures (NOT % coverage, which hides thin seams):
    residualArea: number          // mm^2 of uncut stock remaining
    /** WO-443: residualArea split by RESPONSIBILITY, so nothing hides. `Walker` is what
     *  the adaptive walk left standing in its own region; `FinishBand` is what still
     *  stands inside the band the wall-finishing contour is credited with (always 0 when
     *  wallFinish is off). The two sum to residualArea to clipper tolerance.
     *  Declared OPTIONAL only so that hand-built FeatureResult stubs in other suites keep
     *  type-checking; processFeature itself always populates both. */
    residualWalkerArea?: number
    residualFinishBandArea?: number
    residualMaxInscribedR: number // radius of the largest disk that fits in the WALKER's
                                   // residual (WO-443) = half the worst gap width;
                                   // ~arcTol when truly clean
  }
}

export const DEFAULT_INTEGRAL_WALL_FOLLOW_LENGTH_FACTOR = AP.caps.integralWallFollowLengthFactor

/** Preserve the historical direct wall-follow budget for absent or unusable authored data. */
export function resolveIntegralWallFollowLengthFactor(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? value!
    : DEFAULT_INTEGRAL_WALL_FOLLOW_LENGTH_FACTOR
}

// Safety caps so a geometry edge case can never hang the worker.
const MAX_PASSES = AP.steering.maxPasses
const MAX_POINTS_PER_PASS = AP.steering.maxPointsPerPass
/** WO-3057: how far (in tool radii, from the tool-centre region boundary) a free cut on a
 *  stock-outline component must be before it steers from the last travelled heading (WO-2850)
 *  instead of the gyro average. Measured: 1.25 re-reddens adaptiveWallBand (580.7 mm path);
 *  1.5 / 1.75 / 2.0 hold all seven quality records and keep the WO-2850 boss rough at
 *  7.5 / 6.9 / 7.4 % flips on its original stick (pre-WO-2850: 15.2 %). */
const FREE_CUT_TRAVEL_HEADING_RADII = 1.5

function ensureCCW(loop: Loop): Loop { return loopArea(loop) < 0 ? [...loop].reverse() : loop }
function ensureCW(loop: Loop): Loop { return loopArea(loop) > 0 ? [...loop].reverse() : loop }
function orientClosedTravel(points: Pt[], forwardTravel: boolean): Pt[] {
  return forwardTravel ? points : [...points].reverse()
}

/** WO-453: SEAM WHERE THE TOOL STANDS. Rotate a CLOSED travel polyline so it begins at the
 *  vertex nearest `from` -- the point the connection into it is planned from.
 *
 *  WHY THIS IS FREE. A closed loop's start index carries no machining meaning: the same
 *  vertices are visited, in the same order, in the same travel sense, removing the same
 *  material. Winding is untouched (the caller's orientClosedTravel decision stands), no
 *  vertex is added or dropped, and the head is NOT skipped -- unlike planGatedLanding's
 *  forward re-seam, which drops a prefix and is therefore switched off for closed laps.
 *  What DOES change is the flight into the ride: clipper's loop[0] is an arbitrary vertex,
 *  and on BootL it put the cleanup contour's seam 64.56 mm from where the roughing walk
 *  finished when the nearest vertex of that same contour stood 2.48 mm away (WO-452
 *  finding 2).
 *
 *  DETERMINISTIC: nearest vertex by Euclidean distance, ties resolved to the LOWEST index
 *  (the comparison is strictly less-than, so an exact tie keeps the earlier vertex).
 *
 *  A NO-OP unless the polyline is genuinely closed (last point === first, to 1e-9) and a
 *  source point exists: an OPEN ride's head is material that only it removes, so rotating
 *  one would drop that stretch of wall. */
function reseamClosedTravel(points: Pt[], from: Pt | null): Pt[] {
  if (!from || points.length < 4) return points
  const first = points[0], last = points[points.length - 1]
  if (Math.hypot(last.x - first.x, last.y - first.y) > 1e-9) return points
  const ring = points.slice(0, -1)
  let best = 0
  let bestDistSq = Infinity
  for (let i = 0; i < ring.length; i++) {
    const dx = ring[i].x - from.x, dy = ring[i].y - from.y
    const d = dx * dx + dy * dy
    if (d < bestDistSq) { bestDistSq = d; best = i }
  }
  if (best === 0) return points
  return [...ring.slice(best), ...ring.slice(0, best), { x: ring[best].x, y: ring[best].y }]
}

interface WallCleanupDirectionFallback { rejected: boolean }

/** True when a wall-clean ride presents the requested physical material side.
 *  Resolve the physical boundary geometrically: buildWallFollow's loop index can become
 *  stale after loopback trimming near adjacent boundaries. The ride remains tangent to
 *  its adaptive cut; a wrong-side ride must be rejected rather than reversed into a
 *  180deg cusp. */
function wallRideMatchesDirection(
  ride: WallFollowRide,
  cutRegion: Loops,
  millingDirection: AdaptiveMillingDirection,
): boolean {
  return wallPointsMatchDirection(ride.points, cutRegion, millingDirection)
}

/** Direction on a wall is its arc coordinate, not whether a tiny side probe
 * happens to fall inside a faceted polygon. Used by the explicit 3D contract.
 *
 * WO-1235: only a segment that actually FOLLOWS the wall has a wall direction. Two
 * points can both stand on the same loop while the segment between them crosses the
 * cleared region (a 30 mm chord from one side of a stock section to the other), or
 * clips a convex corner well clear of both walls. The loop's short-way arc between
 * such points is far longer than the chord, exactly the test the wall-coverage
 * bookkeeping uses to refuse crediting a step that did not ride the arc. Such a
 * segment touches no wall, so it has no wall direction to keep or reverse; judging it
 * by its endpoints' arc coordinates forced a retract for every one of them on Operator's
 * modelled slab and on the taper boss. */
function wallRouteKeepsDirection(points: Pt[], loops: Loops, direction: AdaptiveMillingDirection, near: number): boolean {
  for (let i = 1; i < points.length; i++) {
    const a = projectOnLoops(points[i - 1], loops), b = projectOnLoops(points[i], loops)
    if (a.loop < 0 || a.loop !== b.loop || a.dist > near || b.dist > near) continue
    const loop = loops[a.loop], table = cachedLoopArcTable(loop)
    if (!(table.per > 0)) continue
    const s0 = arcCoordOf(loop, table, a.seg, a.foot), s1 = arcCoordOf(loop, table, b.seg, b.foot)
    let delta = s1 - s0
    if (delta > table.per / 2) delta -= table.per
    if (delta < -table.per / 2) delta += table.per
    const chord = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    if (Math.abs(delta) > chord + 2 * near) continue
    if ((materialSideFor(direction) === 'left' ? -delta : delta) < -1e-4) return false
  }
  return true
}

function wallPointsMatchDirection(
  points: Pt[],
  cutRegion: Loops,
  millingDirection: AdaptiveMillingDirection,
): boolean {
  if (points.length < 2) return false
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    const dx = b.x - a.x, dy = b.y - a.y
    const length = Math.hypot(dx, dy)
    if (length <= 1e-9) continue
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    let nearestLoop: Loop | null = null
    let nearestDistanceSq = Infinity
    for (const loop of cutRegion) {
      for (let j = 0; j < loop.length; j++) {
        const p = loop[j], q = loop[(j + 1) % loop.length]
        const lx = q.x - p.x, ly = q.y - p.y
        const lengthSq = lx * lx + ly * ly
        const t = lengthSq > 1e-12
          ? Math.max(0, Math.min(1, ((midpoint.x - p.x) * lx + (midpoint.y - p.y) * ly) / lengthSq))
          : 0
        const px = p.x + t * lx, py = p.y + t * ly
        const distanceSq = (midpoint.x - px) ** 2 + (midpoint.y - py) ** 2
        if (distanceSq < nearestDistanceSq) {
          nearestLoop = loop
          nearestDistanceSq = distanceSq
        }
      }
    }
    if (!nearestLoop) return false
    const leftProbe = {
      x: midpoint.x - 1e-3 * dy / length,
      y: midpoint.y + 1e-3 * dx / length,
    }
    const leftInside = pip2(leftProbe, nearestLoop) === 1
    const leftIsCleared = loopArea(nearestLoop) > 0 ? leftInside : !leftInside
    return materialSideFor(millingDirection) === 'left' ? !leftIsCleared : leftIsCleared
  }
  return false
}

/** True when the loopback's TRIMMED wall ride presents the requested physical material side.
 *
 *  The same question `wallPointsMatchDirection` asks, and -- wherever the probe can actually
 *  answer it -- the same answer. What differs is the PRECONDITION, which WO-1069 half-diagnosed
 *  and WO-1090 measured: the 1e-3mm side probe only separates the two sides when the sample sits
 *  ON the wall. A ride trimmed back to a loopback fillet contact does not. Its first segment is a
 *  chord from that off-wall contact to the first wall vertex, and measured across the nine gt
 *  fixtures that chord's midpoint lands up to 0.022mm past the wall, INSIDE the keep-out, on 27
 *  transitions -- 22x the probe's reach. Both probes then read MATERIAL and the verdict collapses
 *  to a constant with no direction in it: "reject" for climb, "accept" for conventional.
 *
 *  So the sides are read separately and the degenerate case is named instead of assumed:
 *
 *   - The two probes DISAGREE: the boundary is resolved, the probe answers. Identical to
 *     `wallPointsMatchDirection`.
 *   - Both read MATERIAL: the sample is inside the wall. The boundary it belongs to is the
 *     nearest wall segment and the material side is that segment's WINDING -- the cleared field
 *     lies LEFT of a cut-region loop's own winding for both loop kinds (outer, area > 0: the
 *     interior is cleared and lies left of its winding; hole, area < 0: the cleared side is
 *     OUTSIDE the hole, which again lies left of its winding). So "cleared on the ride's left"
 *     is exactly "the ride runs WITH the nearest wall segment's winding". Measured, that agrees
 *     with the probe on every segment the probe resolves, and it is a PROOF rather than a pass:
 *     a ride buried in stock and running backwards is still rejected here.
 *   - Both read CLEARED: the sample floats in open cleared stock, so there is no material on
 *     either side for the ride to present. The probe's own reading -- cleared IS on the left --
 *     stands, which is what climb asks for and what conventional forbids (WO-1896 rule).
 *
 *  SCOPE: the loopback's trimmed rides only. The probe's other three callers take on-wall
 *  polylines (the raw cusp rides, the boundary span, the WO-438 boundary arcs) where the
 *  precondition holds. Switching those too was measured: it moves all nine gt fixture
 *  fingerprints (src/tests/evidence/WO-1090/gate-scope-census.txt), so they stay on the probe.
 */
function wallPointsPresentMaterialSide(
  points: Pt[],
  cutRegion: Loops,
  millingDirection: AdaptiveMillingDirection,
): boolean {
  if (points.length < 2) return false
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    const dx = b.x - a.x, dy = b.y - a.y
    const length = Math.hypot(dx, dy)
    if (length <= 1e-9) continue
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    let nearestLoop: Loop | null = null
    let nearestSegDir: Pt | null = null
    let nearestDistanceSq = Infinity
    for (const loop of cutRegion) {
      for (let j = 0; j < loop.length; j++) {
        const p = loop[j], q = loop[(j + 1) % loop.length]
        const lx = q.x - p.x, ly = q.y - p.y
        const lengthSq = lx * lx + ly * ly
        const t = lengthSq > 1e-12
          ? Math.max(0, Math.min(1, ((midpoint.x - p.x) * lx + (midpoint.y - p.y) * ly) / lengthSq))
          : 0
        const px = p.x + t * lx, py = p.y + t * ly
        const distanceSq = (midpoint.x - px) ** 2 + (midpoint.y - py) ** 2
        if (distanceSq < nearestDistanceSq) {
          nearestLoop = loop
          nearestSegDir = lengthSq > 1e-12
            ? { x: lx / Math.sqrt(lengthSq), y: ly / Math.sqrt(lengthSq) }
            : null
          nearestDistanceSq = distanceSq
        }
      }
    }
    if (!nearestLoop) return false
    const clearedAt = (probe: Pt): boolean => {
      const inside = pip2(probe, nearestLoop!) === 1
      return loopArea(nearestLoop!) > 0 ? inside : !inside
    }
    const leftIsCleared = clearedAt({
      x: midpoint.x - 1e-3 * dy / length,
      y: midpoint.y + 1e-3 * dx / length,
    })
    const rightIsCleared = clearedAt({
      x: midpoint.x + 1e-3 * dy / length,
      y: midpoint.y - 1e-3 * dx / length,
    })
    if (!leftIsCleared && !rightIsCleared) {
      // Buried in the wall: the probe has no side to report, the winding does.
      if (!nearestSegDir) return false
      const runsWithWinding = (dx * nearestSegDir.x + dy * nearestSegDir.y) > 0
      return materialSideFor(millingDirection) === 'left' ? !runsWithWinding : runsWithWinding
    }
    return materialSideFor(millingDirection) === 'left' ? !leftIsCleared : leftIsCleared
  }
  return false
}

/** Is toolPos outside the machinable region? A point is outside if it is not inside any
 *  root contour, OR it is inside one of that root's holes (an island). Port of
 *  ProcessFeature.isOutsideCutRegion -- but NOT the include_boundary branch: FreeCAD's
 *  pyclipper returns -1 for ON-boundary, whereas our pip2 returns -1 for OUTSIDE and
 *  has no on-boundary state, so porting `pip == -1 -> outside` literally made every
 *  point that was merely OUTSIDE A HOLE read as outside the region. That mis-fired the
 *  boundary-reach break on every island fixture (SquareIsland). */
function isOutsideCutRegion(toolPos: Pt, tree: PolyNode[]): boolean {
  for (const node of tree) {
    if (pip2(toolPos, node.contour) === 1) { // inside this root contour
      for (const hole of node.children) {
        if (pip2(toolPos, hole.contour) === 1) return true // inside an island -> outside region
      }
      return false // inside the root and clear of every island -> inside the region
    }
  }
  return true // not inside any root contour -> outside region
}

// Local point-in-polygon (ray cast) to avoid a wasm round-trip per query; returns
// -1 outside / 0 on (approx) / +1 inside, matching pyclipper's convention closely enough
// for the region test (exact on-boundary is rare and handled by includeBoundary callers).
function pip2(pt: Pt, loop: Loop): -1 | 0 | 1 {
  let inside = false
  const bands = loop.length >= SEG_GRID_MIN_SEGMENTS ? yBandsOf(loop) : null
  if (bands) {
    // WO-3024: only edges that straddle pt.y can flip the parity, and each band lists every
    // edge whose y-range meets it; the parity is the full scan's (order does not matter).
    if (!(pt.y >= bands.minY && pt.y <= bands.maxY)) return -1
    const band = bands.edges[Math.min(bands.n - 1, Math.floor((pt.y - bands.minY) / bands.h))]
    for (const i of band) {
      const j = i === 0 ? loop.length - 1 : i - 1
      const a = loop[i], b = loop[j]
      const intersect = (a.y > pt.y) !== (b.y > pt.y) &&
        pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x
      if (intersect) inside = !inside
    }
    return inside ? 1 : -1
  }
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i], b = loop[j]
    const intersect = (a.y > pt.y) !== (b.y > pt.y) &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x
    if (intersect) inside = !inside
  }
  return inside ? 1 : -1
}
interface YBands { len: number; minY: number; maxY: number; h: number; n: number; edges: number[][] }
const yBands = new WeakMap<Loop, YBands>()
/** pip2's edges (loop[j] -> loop[i], j = i - 1) bucketed by horizontal band of y. */
function yBandsOf(loop: Loop): YBands {
  const cached = yBands.get(loop)
  if (cached && cached.len === loop.length) return cached
  let minY = Infinity, maxY = -Infinity
  for (const q of loop) { if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y }
  const n = Math.max(1, Math.ceil(Math.sqrt(loop.length)))
  const h = Math.max((maxY - minY) / n, 1e-9)
  const edges: number[][] = Array.from({ length: n }, () => [])
  const band = (y: number): number => Math.min(n - 1, Math.max(0, Math.floor((y - minY) / h)))
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[i === 0 ? loop.length - 1 : i - 1]
    const lo = band(Math.min(a.y, b.y)), hi = band(Math.max(a.y, b.y))
    for (let k = lo; k <= hi; k++) edges[k].push(i)
  }
  const bands = { len: loop.length, minY, maxY, h, n, edges }
  yBands.set(loop, bands)
  return bands
}

export function processFeature(
  feat: Feature,
  params: ProcessParams,
  // Optional progress callback: fraction (0..1) of THIS feature's completion, reported at
  // the top of each outer pass. Backward compatible (optional) so existing
  // callers/tests are unaffected. Progress-only: emits NO geometry (bytestab invariant).
  onPassProgress?: (frac: number) => void,
  onAcceptedGraphRoute?: AcceptedGraphRouteObserver,
): FeatureResult {
  if (!params.repositionTime?.trial) processFeatureRequestRecorder?.({ feature: feat, params })
  const { toolRadius, stepOver, tolerance } = params
  // A missing direction is climb: material on the right (./millingDirection, WO-1896),
  // which is the historical canonical-forward stream.
  const millingDirection = params.millingDirection ?? 'climb'
  const forwardTravel = materialSideFor(millingDirection) === 'right'
  const stockToLeave = params.stockToLeave ?? 0
  const landingUncutCap = params.landingUncutCap ?? LANDING_UNCUT_CAP
  if (!Number.isFinite(landingUncutCap) || landingUncutCap < 0 || landingUncutCap > 1) {
    throw new Error(`processFeature: landingUncutCap must be finite and in [0, 1], got ${landingUncutCap}`)
  }
  const arcTol = params.arcTol ?? Math.max(tolerance * AP.sampling.arcTolFraction, AP.sampling.arcTolFloorMm)
  // WO-3054: a plunge setting can still make this feature a helix entry (below, once the first
  // entry is known), so the radius every route reads is settled there.
  let helixRadius = params.helixDiameter / 2
  // WO-3054 fix 1: emit turns a planned helix smaller than the operator's minimum helix radius
  // into a straight plunge, so a helix entry into a closed region is planned at least that wide.
  const operatorHelixFloor = Number.isFinite(params.minHelixRadius) ? Math.max(params.minHelixRadius!, 0) : 0
  if (helixRadius >= MIN_DESCENT_HELIX_RADIUS && helixRadius < operatorHelixFloor) helixRadius = operatorHelixFloor
  const integralWallFollowLengthFactor =
    resolveIntegralWallFollowLengthFactor(params.integralWallFollowLengthFactor)

  wallCleanStats.fired = 0; wallCleanStats.transitions = 0
  b8GateStats.rejections = 0; b8GateStats.routedAround = 0; b8GateStats.routedAroundChord = 0; b8GateStats.routedDetour = 0; b8GateStats.stoppedShort = 0; b8GateStats.routedWallChain = 0
  wallCoverStats.boundaryLen = 0; wallCoverStats.coveredLen = 0; wallCoverStats.filledLen = 0
  wallCoverStats.gaps = 0; wallCoverStats.filled = 0
  wallCoverStats.orderedGapConnectionLen = 0; wallCoverStats.filledGapConnectionLen = 0
  wallCoverStats.gapOrderOrderedPlanLen = 0; wallCoverStats.gapOrderNearestPlanLen = 0
  wallCoverStats.gapOrderShorterPlan = 'none'; wallCoverStats.gapOrderChoice = 'none'
  wallCoverStats.skippedShort = 0; wallCoverStats.skippedEmpty = 0
  wallCoverStats.refusedApproach = 0; wallCoverStats.refusedOverload = 0; wallCoverStats.refusedDirection = 0
  droppedSliverStats.largestEntryRadius = null; droppedSliverStats.regions.length = 0
  // WO-439 census: cleared per run like the two stat blocks above. Write-only sink.
  fragCensus.passEnds.length = 0; fragCensus.reseeds.length = 0; fragCensus.entries.length = 0
  const singleWallPass = params.wallFinish === true && params.singleWallPass === true
  const finishStock = (singleWallPass ? 0 : tolerance / 2) + stockToLeave
  // WO-439 fix 1 -- SCOPED TO THE STALLED-RIM SKIM DECISION BELOW AND NOTHING ELSE.
  // How far outside cutRegion still counts as "on the wall" when deciding whether a
  // tangential SLIDE may be attempted. cutRegion is a FACETED offset polygon (chord
  // tolerance arcTol) and the engage walker plants pass starts exactly ON its vertices, so
  // a slide that rides ALONG the wall sits within one facet's sagitta of it -- and pip2's
  // strict ray cast, which has no on-boundary state, calls that OUTSIDE. The slide was
  // therefore refused BEFORE its load was ever measured: the step-1 census counted 731 of
  // 807 (Bar) and 1681 of 1768 (Triangle) pass endings as 'skim-refused-outside', and
  // ZERO load refusals anywhere. Inside this tolerance the slide is handed to the stay-down
  // load cap (1.5 x stepover, unchanged, a few lines below), which is the real judge.
  // SAFETY: the excursion this permits eats at most half of the finishStock rim that
  // cutRegion already holds back, so the finished wall is never touched. pip2 itself, the
  // gouge veto, the boundary-reach clip and every other consumer of isOutsideCutRegion /
  // centrePathExitsCutRegion stay STRICT -- this tolerance exists at one call site.
  const SKIM_ON_WALL_EPS = Math.min(arcTol, finishStock / 2)
  const toolDia = toolRadius * 2
  const stepOverDistance = toolDia * stepOver
  const tool = createToolGeometry(toolRadius, stepOver, arcTol)
  const optimal = tool.optimalCutAreaPerDist

  // Machinable region: feature offset inward by toolRadius + finish stock.
  const featLoops: Loops = [ensureCCW(feat.boundary), ...(feat.holes ?? []).map(ensureCW)]
  // WO-1178 (WO-431) AN EXTERIOR SEED DECLARES THE BOUNDARY IT ABUTS OPEN. A clearedSeed is
  // the air around the stock, already cleared, and the feature's outer boundary is then the
  // stock's own edge -- not a wall that owes finish stock. The tool-centre region used to be
  // built from the feature alone, so that edge was inset like a pocket wall: the roll-in
  // point getEngagePoint places R - protrusion outside the edge stood outside the region, the
  // opening pass ran unchecked where the wall test does not reach and was refused the moment
  // it came within a radius, and the region never gained a cleared point (sideSeedStage1:
  // 0.0003 mm2 of 2654 covered). The region is now the feature UNITED with the seed: the
  // holes (the part's walls) keep their inset, the open edge lets the cutter stand in the air
  // it came from, and the walker, the gates and the accounting all see the same space. The
  // roll-in itself is still planned against the real footprint (featLoops below), so it pokes
  // into stock, never into air.
  //
  // WO-1178 fix round: ONLY A SEED THAT TOUCHES THE FEATURE OPENS IT. The 3D rougher hands
  // the SAME exterior seed (the air round the stock section) to every component of a level,
  // including a pocket or a bore standing on its own inside the part. United with such a
  // component the seed does not open anything -- it wraps it: the tool-centre tree then reads
  // big-box -> stock-footprint hole -> pocket, and isOutsideCutRegion (root, then its direct
  // holes) sees the pocket as "inside a hole", so no entry was ever found there and the level
  // planned nothing (wo101RemainderPasses: the pocket floor never cut; restWiring.wo279: a
  // closed pocket ending in no-start-point; adaptive3dTallStockHelixFloor: no helix in the
  // bore). A seed that shares no ground with the feature grown by one tolerance is air the
  // feature cannot be reached from: the region stays the feature, exactly as before this
  // order, and the seed is still `cleared` for the roll-in search and the accounting.
  const seedAbutsFeature = params.clearedSeed && params.clearedSeed.length > 0
    ? totalArea(intersection(offsetClosed(featLoops, tolerance, arcTol), params.clearedSeed)) > arcTol * arcTol
    : false
  const regionLoops: Loops = seedAbutsFeature
    ? union(featLoops, params.clearedSeed!)
    : featLoops
  const cutTree = offsetClosedTree(regionLoops, -(toolRadius + finishStock), arcTol)
  // ---- WO-465: NEVER MAKE A REGION THE TOOL CANNOT ENTER (Operator's FIRST GOAL) ----
  // The inset above can manufacture tool-centre components that exist only because two
  // walls' offsets happen to miss each other. The diagnosed one (restWiring.wo279
  // op-rough-8, first level) is 0.373 x 1.500 mm at the mouth of the H's crossbar: a lens
  // pinched between the dilated island wall and the two crossbar corners, 0.273 mm2, whose
  // largest fitting entry is 0.161 mm against a 0.200 mm floor. Made into a region it needs
  // its own descent, no descent fits, and the operation used to die.
  //
  // WO-464 already refuses to seed such a component once the walk reaches it. This is the
  // earlier and better answer Operator asked for: the component is never a region at all, so
  // nothing walks its boundary, no entry is ever planned for it, and its material stays in
  // the honest residual for a smaller tool. Operator's ruling keeps BOTH -- prevention is the
  // best case, WO-464's re-seed buffer is the net for every case prevention does not see
  // (a leftover the WALK creates, and any component this filter declines to judge).
  //
  // The question asked is the same yes/no geometric one WO-464 settled on, for the same
  // reason: findStartPointIn in REQUESTED-SIZE mode samples MIN_DESCENT_HELIX_RADIUS
  // exactly. The approximate capacity search is run only AFTER the decision, as evidence.
  //
  // DELIBERATELY NARROW, three ways, because a wrong drop abandons real material:
  //   - a single-component cutRegion is never touched (findEntry / 'no-start-point' and
  //     WO-464's "the feature's FIRST entry is unchanged" promise both stand);
  //   - the filter never empties cutRegion;
  //   - it is skipped entirely when clearedSeed is set. An outside-in feature enters
  //     LATERALLY from pre-cleared air, so the descent floor is not the question its
  //     regions are judged by, and dropping one would throw away material the roll-in
  //     can take. Those features keep exactly WO-464's behaviour.
  const cutRegionAll = offsetClosed(regionLoops, -(toolRadius + finishStock), arcTol)
  const prevented = params.clearedSeed && params.clearedSeed.length > 0
    ? { cutRegion: cutRegionAll, dropped: [] as DroppedComponent[] }
    : dropUnenterableCutRegionComponents(cutRegionAll, cutTree, toolRadius, tolerance, arcTol)
  const cutRegion = prevented.cutRegion
  // WO-1178: A ROLL-IN ENGAGE CENTRE IS A TOOL POSITION AND TAKES THE SAME VETO AS EVERY OTHER.
  // getEngagePoint places the engage centre one protrusion (up to 0.1 x stepover) past the
  // cleared edge into whatever stands there, judged against `cleared` alone. Where what stands
  // there is thinner than that protrusion -- the finish skin over a retained wall -- the poke
  // goes through the skin into the part: on the 10 mm ring with the 9.52 mm cutter the 3D
  // emitter refused the emitted move for exactly that ("retained-model collision ... requires
  // Z >= 5.0"). The centre must stand inside the tool-centre region (on its wall to within the
  // same tolerance the wall skim uses), or the roll-in is not offered.
  const engageInsideRegion = (p: Pt): boolean =>
    !isOutsideCutRegion(p, cutTree) || distToLoops(p, cutRegion) <= SKIM_ON_WALL_EPS
  // The MATERIAL region: everything the roughing pass may remove (the feature less the
  // finishing stock). Identical expression to the one the residual measure used to build
  // for itself at the end of this function -- hoisted here because WO-439 fix 2 needs it
  // during the pass loop, and computed once instead of twice.
  const targetRegion = offsetClosed(regionLoops, -finishStock, arcTol)

  const emptyStats = { passes: 0, points: 0, cacheHits: 0, cacheMisses: 0, residualArea: 0, residualWalkerArea: 0, residualFinishBandArea: 0, residualMaxInscribedR: 0 }
  const empty: FeatureResult = {
    startPoint: null, entries: [], passes: [], cleared: [], cutRegion, residual: [],
    stats: { ...emptyStats, aborted: 'no-cut-region' },
  }
  if (cutRegion.length === 0) return empty

  // ---- WO-443 NESTED CLEANUP / WO-445 CREDITED BAND / WO-447 COMPLETED COVERAGE ----
  // ACTIVE ONLY when params.wallFinish is true. With it false every expression below is
  // skipped, walkerRegion IS targetRegion by identity, and the walk stays byte-identical.
  //
  // The wall is ridden ONCE, WHOLE, in two layers of depth taken by two different providers:
  //   1. the MACHINING-LOAD layer, taken during ROUGHING at the roughing offset
  //      offsetClosed(featLoops, -(toolRadius + finishStock)) -- the SAME offset the
  //      cutRegion is built at. Its provider is the COMPLETED WALL-FOLLOW COVERAGE: the
  //      wallCleanupAsWeGo transition rides, PLUS the WO-447 gap-fill rides that ride the
  //      stretches no transition happened to reach (emitted below, before the wall-finish
  //      pass). On the branch where the full cleanup-contour loop runs instead, THAT loop
  //      is the provider and covers the whole boundary by construction.
  //   2. the SKIN layer, taken by the WALL-FINISH pass at
  //      offsetClosed(featLoops, -(toolRadius + wallFinishNearDepth)), which then meets only
  //      the skin standing between its own offset and the roughing offset, i.e.
  //      `finishStock - wallFinishNearDepth`. WO-450 MOVED THIS LAYER: by default
  //      wallFinishNearDepth = stockToLeave, so the lap stops the operator's radial stock
  //      off the wall and meets the tolerance / 2 skin alone; under wallFinishToNet the
  //      depth is 0, the lap is back ON the true wall at -toolRadius and meets the whole
  //      finishStock skin -- the pre-WO-450 shape, term for term.
  // WO-447 (Operator's option A, 2026-08-20): layer 1's provider used to be WO-445's SEMI LAP --
  // a SECOND full perimeter at the roughing offset. He rejected riding the perimeter twice;
  // completed coverage rides only the MISSED fraction instead. LAYER 1's CREDIT EXPRESSION
  // AND DEPTH ARE UNCHANGED from WO-445 -- only who provides layer 1 changed. LAYER 2's
  // credit was RE-DERIVED by WO-450 when its offset moved, so that it is still exactly the
  // skin the lap meets and never more; the per-layer breakdown below is the live statement
  // of both, and it governs.
  //
  // Material inside the credited band is therefore not the walker's job. Letting the
  // walker read it as bite is what produced the rim-nibble crumb passes: at matched reference
  // settings (stepover 0.4D) Comma cut 200 passes against the reference path's 63, Kidney 256 against
  // 79, Barbell ~4.2x -- crumb polishing of exactly the wall band the wall rides remove
  // anyway. (Measured again under WO-446, which removed the band and reproduced exactly
  // that regression: 3.17x / 3.20x / 4.22x with a lift storm behind it.)
  //
  // THE CREDIT IS PER LAYER, and each layer is credited ONLY the depth it is allowed to take
  // (WO-445, Operator's ruling 2026-08-23 that 1.5 x optimal is too much load for a FINISHING
  // pass). Depths are radial engagement, denominated in the engine's load currency:
  // effective width in mm, i.e. swept-area-per-mm of travel (GOOD-SPEC section 2).
  //   - the FINISH LAP is credited exactly the skin it meets, and no more: the gap between
  //     the roughing offset (toolRadius + finishStock) and its own offset
  //     (toolRadius + wallFinishNearDepth), i.e. `finishStock - wallFinishNearDepth`.
  //     WO-450 RE-DERIVED THIS RATHER THAN PATCHING IT. By default the lap now stops
  //     `stockToLeave` off the wall (wallFinishNearDepth = stockToLeave), and since
  //     finishStock IS tolerance / 2 + stockToLeave the credit is exactly tolerance / 2 --
  //     the tolerance skin, which is all that stands between the two offsets. Under
  //     wallFinishToNet the lap is back on the true wall (wallFinishNearDepth = 0) and the
  //     credit is the whole finishStock, arithmetically what WO-445 wrote. Either way the
  //     lap is credited NONE of the roughing band.
  //   - the ROUGHING WALL COVERAGE is credited WALL_BAND_LOAD_CAP = optimal, the DESIGNED
  //     load, past the finishStock line. Deliberately NOT the 1.5 x optimal engage ceiling:
  //     this is a wall-hugging cut with no open side (GOOD-SPEC section 2 - one-sided
  //     tolerance, under is only time, over deflects), so conservative is correct.
  //     UNCHANGED by WO-450: the rougher's offset did not move, so neither did its credit.
  // Credit therefore runs from depth `wallFinishNearDepth` (measured from the true wall)
  // down to D = min(2 * toolRadius, finishStock + optimal) -- 2.15 mm at matched settings,
  // where WO-443's single annulus credited 2.40. Two bands are credited to NOBODY, and both
  // are honest: [0, wallFinishNearDepth] is the stock the operator asked to KEEP, which no
  // pass removes; everything deeper than D stays the walker's responsibility and is cleared
  // by roughing. So what each ride actually meets is bounded by the depth it was credited
  // under. That is the honesty bound -- by construction, not by hope. NEVER credit more.
  const WALL_BAND_LOAD_CAP = optimal
  // ONE contour per layer, computed once here and reused by the emits below, so the band
  // credited here and the geometry actually ridden can never drift apart. The roughing-offset
  // contour is the SAME EXPRESSION as cutRegion above
  // (offsetClosed(featLoops, -(toolRadius + finishStock), arcTol)); it is reused rather
  // than recomputed for exactly that reason. Where finishStock is thinner than the polygon
  // resolution the two contours are the same ride, so there is no separate roughing layer.
  // WO-450: HOW FAR OFF THE WALL THE FINISH LAP STOPS, and the one number the credit above
  // and the contour below both read. Operator set the operation's radial "Stock to leave" to 0.5
  // and the finish lap still cut to net, because this contour was offset by toolRadius ALONE
  // -- `stockToLeave` held the ROUGHER back (finishStock, above) and the lap then removed
  // exactly what the rougher had been told to leave. Offsetting by
  // toolRadius + stockToLeave makes the setting mean what it says on the FINISHED wall; the
  // lap then meets only the tolerance / 2 skin above it. wallFinishToNet = true is the
  // explicit opt-out and reproduces the old geometry term for term.
  const wallFinishNearDepth = params.wallFinishToNet === true ? 0 : stockToLeave
  const wallFinishContour: Loops = params.wallFinish
    ? offsetClosed(featLoops, -(toolRadius + wallFinishNearDepth), arcTol)
    : []
  // skipOuterBoundaryCleanup applies to the roughing wall layer for the same reason it
  // applies to the cleanup contour it shares an offset with: on a stock-outline component the
  // positive-area loop is an artificial open edge with no retained wall to finish, and riding
  // it grazes air and manufactures corner re-entry landings. Dropping those loops here
  // withdraws the credit as well as the ride (WO-447 gap-fill honours the same filter), so
  // the walker keeps the responsibility -- the safe direction.
  const wallBandContour: Loops = params.wallFinish && (singleWallPass || finishStock > arcTol)
    ? (params.skipOuterBoundaryCleanup ? cutRegion.filter(loop => loopArea(loop) <= 0) : cutRegion)
    : []
  // sweep = union over contour loops of (dilate by toolRadius - erode by toolRadius) -- the
  // same band construction the cleanup-contour fold below uses for its own ride. Where a
  // contour is EMPTY (a slot too narrow for the tool) there is NO sweep and the walker
  // keeps full responsibility -- no special case needed, the loop simply contributes
  // nothing there.
  const contourSweep = (contour: Loops): Loops => {
    let sweep: Loops = []
    for (const loop of contour) {
      if (loop.length < 3) continue
      const ccw = ensureCCW(loop)
      const loopBand = difference(
        offsetClosed([ccw], toolRadius, arcTol),
        offsetClosed([ccw], -toolRadius, arcTol),
      )
      if (loopBand.length === 0) continue
      sweep = sweep.length === 0 ? loopBand : union(sweep, loopBand)
    }
    return sweep
  }
  // The annulus between two depths measured from the TRUE WALL (featLoops) inward. Both
  // depths are clamped to the tool diameter, as deep as a contour ride can physically reach.
  const wallAnnulus = (nearDepth: number, farDepth: number): Loops => {
    const near = Math.min(nearDepth, 2 * toolRadius)
    const far = Math.min(farDepth, 2 * toolRadius)
    if (!(far > near)) return []
    const outer = near <= 0 ? featLoops : offsetClosed(featLoops, -near, arcTol)
    if (outer.length === 0) return []
    const inner = offsetClosed(featLoops, -far, arcTol)
    return inner.length === 0 ? outer : difference(outer, inner)
  }
  // The credited band: the union of each ride's own sweep clipped to its own legal depth,
  // then clipped to the material a roughing pass may remove. Note the finish-lap term is
  // (correctly) swallowed by that last clip whenever finishStock > 0 -- targetRegion starts
  // at the finishStock line -- but it is written out because it is the honest expression:
  // the wall pass IS credited its skin, the skin simply is not roughing material.
  // WO-450 CONSEQUENCE, AND WHY THE WALK CANNOT MOVE: the lap's annulus is
  // [wallFinishNearDepth, finishStock], which lies ENTIRELY above the finishStock line at
  // either setting of wallFinishToNet, so that clip removes it either way. finishBand,
  // walkerRegion and therefore every pass the walker plans are byte-identical to before --
  // moving the lap changes the lap, and nothing upstream of it.
  const finishBand: Loops = (() => {
    if (!params.wallFinish) return []
    let stack: Loops = []
    const add = (band: Loops) => { if (band.length) stack = stack.length === 0 ? band : union(stack, band) }
    if (wallFinishContour.length > 0 && finishStock > wallFinishNearDepth) {
      const annulus = wallAnnulus(wallFinishNearDepth, finishStock)
      if (annulus.length) add(intersection(contourSweep(wallFinishContour), annulus))
    }
    if (wallBandContour.length > 0) {
      const annulus = wallAnnulus(finishStock, finishStock + WALL_BAND_LOAD_CAP)
      if (annulus.length) add(intersection(contourSweep(wallBandContour), annulus))
    }
    if (stack.length === 0) return []
    // WO-1178: A CONVEX CORNER OF THE CUT REGION IS NEVER CREDITED TO THE WALL RIDE. The
    // credit above is honest along a wall: a ride there meets a band one load-depth thick
    // (WALL_BAND_LOAD_CAP) and no more. Where two walls meet at a corner the cut region turns
    // INSIDE (a pocket corner), the ride pivots on the corner vertex and its cutter sweeps
    // both walls' bands and the square between them at once -- measured on the Bar's
    // top-left corner: 3.46 mm2/mm (87% of a slot) on a 1.07 mm ride, and 3.74 (94%) on the
    // gap-fill ride that finished it. No ride can take that square at bounded load; the
    // spiral's arcs can, one stepover at a time, if the walker is allowed to see it. So the
    // disk that holds the corner's two bands and their square is handed back to the walker:
    // radius = the band depth over cos(turn/2), the diagonal of the corner's band square,
    // about the TRUE wall vertex. Only vertices where the cut region is convex (its interior
    // angle under 180 deg: the outer loop turning left, a hole loop turning left) qualify; at
    // a concave corner the ride turns with the stock inside and its load drops, so the credit
    // stands. Nothing here names a fixture or an angle: every vertex is judged by its turn.
    const bandDepth = finishStock + WALL_BAND_LOAD_CAP
    let cornerDisks: Loops = []
    for (const loop of featLoops) {
      const n = loop.length
      if (n < 3) continue
      for (let i = 0; i < n; i++) {
        const a = loop[(i - 1 + n) % n], v = loop[i], b = loop[(i + 1) % n]
        const ux = v.x - a.x, uy = v.y - a.y, wx = b.x - v.x, wy = b.y - v.y
        const lu = Math.hypot(ux, uy), lw = Math.hypot(wx, wy)
        if (lu <= 1e-9 || lw <= 1e-9) continue
        const cross = (ux * wy - uy * wx) / (lu * lw)
        const dot = (ux * wx + uy * wy) / (lu * lw)
        // A left turn (cross > 0) on a CCW outer loop or a CW hole loop is a convex corner of
        // the cut region. Turns under ~10 degrees are faceting, not corners: the band square
        // there is a sliver the ride already takes under its cap.
        if (cross <= 0) continue
        const turn = Math.atan2(cross, dot)
        if (turn < Math.PI / AP.sharpening.cornerMinTurnDivisor) continue
        // The diagonal diverges as the turn nears 180 deg (a spike); bound the disk at four band
        // depths (a 151 deg turn) -- past that the inset region has no corner to pivot on anyway.
        const radius = Math.min(bandDepth / Math.cos(turn / 2), AP.sharpening.cornerDiskBandDepths * bandDepth)
        cornerDisks = union(cornerDisks, diskPath(v, radius, arcTol))
      }
    }
    const credited = cornerDisks.length ? difference(stack, cornerDisks) : stack
    if (credited.length === 0) return []
    return intersection(credited, targetRegion)
  })()
  // What the WALKER is answerable for: the material a roughing pass may remove, LESS the
  // band the wall rides are credited with. Handed to the engage walker as its
  // biteRegion at BOTH construction sites, so diskBiteIn reads band material as zero bite,
  // rim crumbs fall below the pass-progress floor, and the walk exhausts honestly instead
  // of crumb-polishing a rim that is already somebody else's assignment.
  const walkerRegion: Loops = finishBand.length ? difference(targetRegion, finishBand) : targetRegion

  // Helix-sized entry preferred; in a tight pocket use the largest smaller
  // helix that actually fits. A straight plunge remains only for geometry too
  // narrow even for the minimum numerical entry radius; Adaptive 3D rejects
  // such a plunge if live stock is present.
  // `cutRegion` is already the feature inset by the full cutter radius, so every
  // point inside it is a physically valid cutter centre. Requiring another half
  // tool radius of inscribed clearance here rejected narrow-but-valid regions
  // (notably a 15 mm bore with a 9.52 mm cutter) after cutter fit had already
  // been proven. The fallback only needs a small numerical interior margin.
  const findEntry = (searchLoops: Loops, entryRadius = helixRadius): { pt: Pt; seedDisk: Loops; seedRadius: number } | null => {
    const sized = findStartPointIn(searchLoops, cutTree, entryRadius, entryRadius + toolRadius, toolRadius, arcTol)
    if (sized) {
      // WO-1103: in a straight channel the deepest point is the MIDDLE, and a spiral grown
      // there saturates across the width with work stranded at BOTH ends -- the seam
      // WO-1100 measured on Bar. Slide the seed down the channel so the saturated disk
      // touches one end instead of sitting between two. Only the sized (helix) entry is
      // relocated: its seed disk is a FIXED helixRadius + toolRadius, so moving the point
      // cannot change the area credited to `cleared`. The fallback entry's disk is sized by
      // the clearance it found, so relocating it would silently re-credit that disk.
      const moved = endBiasedChannelSeed(searchLoops, cutTree, sized.pt, entryRadius, stepOverDistance, arcTol)
      if (moved) return { pt: moved, seedDisk: diskPath(moved, sized.seedRadius, arcTol), seedRadius: sized.seedRadius }
      return sized
    }
    const fallback = findStartPointIn(
      searchLoops,
      cutTree,
      Math.max(tolerance * AP.sampling.seedSearchTolerances, arcTol),
      undefined,
      toolRadius,
      arcTol,
    )
    if (!fallback) return null
    if (fallback.seedRadius - toolRadius >= MIN_DESCENT_HELIX_RADIUS) return fallback
    // The fallback found room, but less than the smallest helix emit will make
    // (below MIN_DESCENT_HELIX_RADIUS a helix is a wobbling plunge, and Adaptive
    // 3D refuses a plunge into standing stock). Do not promise a helix that
    // cannot be emitted: give this entry the same rescue a lift landing gets -
    // planHelixDescent's halving ladder / inward shift / corner fan finds the
    // largest legal helix near the point, and the seed disk credited to
    // `cleared` is exactly the disk that helix opens. Only when nothing fits is
    // the entry left as the (loud) plunge it always was.
    const rescued = planHelixDescent(fallback.pt, cutRegion, cutTree, entryRadius, toolRadius)
    if (!rescued) return fallback
    const seedRadius = rescued.radius + toolRadius
    return { pt: rescued.center, seedDisk: diskPath(rescued.center, seedRadius, arcTol), seedRadius }
  }
  // WO-3054 (the operator 10-21: "it has to do Helix entry for adaptive into a pocket. It can do
  // adaptive from the outside with the lead in but there is no possibility to do that in a
  // pocket. So the only viable option is a helix or entering in from a previously cleared hole
  // (drilled, bored, etc)."). A plunge opens a hole exactly one tool wide and every first pass
  // out of it is a full slot (WO-3024 finding: the declared H-pocket cut nothing). So under a
  // plunge setting an interior entry goes straight down only where the whole tool disk stands
  // inside a hole an earlier operation already cleared to this feature's deepest level
  // (params.clearedHoles), and the walk starts from the largest disk that hole holds round the
  // entry. Anywhere else it enters with the default helix and the operator is told once. Helix
  // settings and side (roll-in) entries never come here.
  const plungeAsked = helixRadius < MIN_DESCENT_HELIX_RADIUS
  const defaultHelixRadius = Math.max((AP.defaults.helixDiameterPctOfTool / 100) * toolRadius, operatorHelixFloor)
  const holeCentres: Loops = plungeAsked && params.clearedHoles && params.clearedHoles.length > 0
    ? offsetClosed(params.clearedHoles, -toolRadius, arcTol)
    : []
  type Seed = { pt: Pt; seedDisk: Loops; seedRadius: number; hole?: true }
  const findHoleEntry = (searchLoops: Loops): Seed | null => {
    if (holeCentres.length === 0) return null
    const room = intersection(searchLoops, holeCentres)
    if (room.length === 0) return null
    const found = findStartPointIn(room, cutTree, arcTol, undefined, toolRadius, arcTol)
    return found ? { ...found, hole: true } : null
  }
  let helixNoted = false
  const findSeed = (searchLoops: Loops): Seed | null => {
    if (!plungeAsked) return findEntry(searchLoops)
    const hole = findHoleEntry(searchLoops)
    if (hole) return hole
    const helixed = findEntry(searchLoops, defaultHelixRadius)
    if (helixed && !helixNoted) {
      helixNoted = true
      // A helix setting below the smallest helix lands here too: say what the operator chose.
      operatorNotice(params.helixDiameter > 0
        ? 'Entry helix is smaller than the smallest helix in a closed pocket with no cleared hole - entered with the default helix.'
        : 'Plunge entry into a closed pocket with no cleared hole - entered with a helix.')
    }
    return helixed
  }

  // WO-1178: with an exterior seed the region holds the seed's air; the interior fallback entry
  // is searched in the STOCK part of it, never in the air.
  const stockRegion: Loops = params.clearedSeed && params.clearedSeed.length > 0
    ? difference(cutRegion, params.clearedSeed)
    : cutRegion
  // WO-1194: the same distinction stockRegion draws (region-over-stock vs region-over-air),
  // as a measurement the tier-1 keep-down router can ask about ONE POINT AT A TIME. Built only
  // when the caller supplied the exterior seed; null otherwise, which leaves every routed ride
  // judged exactly as it was before this order.
  const exteriorAirAt = params.clearedSeed && params.clearedSeed.length > 0
    ? exteriorAirDepth(params.clearedSeed)
    : null
  // WO-3057: the WO-2850 travelled-heading rule belongs to the stock-outline component only.
  const steersFreeCutsFromTravel = !!params.clearedSeed && params.clearedSeed.length > 0

  // Opt-in outside-in first entry (FreeCAD getEngagePoint roll-in): seed `cleared` with the
  // caller-supplied exterior region and place the tool CENTRE out in that cleared air just
  // past the material edge, grazing in by a load-sized protrusion so the FIRST bite is
  // bounded BY CONSTRUCTION (no helix, no slot). getEngagePoint returns { pt (in air), dir }
  // or null. On null we fall back to the interior helix `findEntry` (`start`, found above) --
  // a NAMED ADR-0003 fallback, logged, never a silent no-op. Skipped entirely when
  // clearedSeed is absent (then the path below is byte-identical to the interior default).
  let sideStart: { pt: Pt; clearPoint: Pt; dir: Pt } | null = null
  if (params.clearedSeed && params.clearedSeed.length > 0) {
    sideStart = getEngagePoint(
      params.clearedSeed,
      tool,
      toolRadius,
      optimal,
      tolerance,
      stepOver,
      featLoops,
      arcTol,
      millingDirection,
      engageInsideRegion,
    )
    if (sideStart && !engageInsideRegion(sideStart.pt)) {
      console.warn(`[side-entry] roll-in at (${sideStart.pt.x.toFixed(2)}, ${sideStart.pt.y.toFixed(2)}) stands outside the tool-centre region (its poke would pass the finish skin) -- falling back to interior helix entry (ADR-0003, WO-1178)`)
      sideStart = null
    } else if (!sideStart) {
      console.warn('[side-entry] getEngagePoint found no bounded roll-in over clearedSeed -- falling back to interior helix entry (ADR-0003)')
    }
  }

  const start = findSeed(stockRegion)
  // WO-3054: a plunge setting whose first entry is an interior one and found no cleared hole
  // runs the whole feature as the default helix setting does, so its re-seeds and its lift
  // landings may open stock with a helix too.
  if (plungeAsked && !sideStart && start && !start.hole) helixRadius = defaultHelixRadius

  if (!start && !sideStart) return { ...empty, stats: { ...empty.stats, aborted: 'no-start-point' } }

  // start! safe: non-null whenever sideStart is null (guarded by the return above)
  let cleared: Loops = sideStart ? params.clearedSeed! : start!.seedDisk
  const startPoint: Pt = sideStart ? sideStart.pt : start!.pt

  // Every region's entry (initial + each re-seed) is recorded so Phase 5 ramps it in
  // (helix where it fits, plunge only where it does not) rather than diving blindly.
  const entries: AdaptiveEntry[] = []
  // 'helix' only when emit will actually make one (>= MIN_DESCENT_HELIX_RADIUS,
  // the single floor shared with emit); anything smaller is honestly a plunge.
  const makeEntry = (e: { pt: Pt; seedRadius: number; hole?: true }): AdaptiveEntry => {
    // WO-3054: into a cleared hole the operator's plunge goes straight down.
    if (e.hole) return { point: e.pt, radius: 0, mode: 'plunge' }
    const radius = Math.max(e.seedRadius - toolRadius, 0)
    return { point: e.pt, radius, mode: radius >= MIN_DESCENT_HELIX_RADIUS ? 'helix' : 'plunge' }
  }
  let pendingEntry: AdaptiveEntry | null = sideStart
    ? { point: sideStart.pt, clearPoint: sideStart.clearPoint, radius: 0, mode: 'side' }
    : makeEntry(start!)
  // WO-1178 (WO-430 item 4a) NO CREDIT WITHOUT MOTION. A re-seed folds its seed disk into
  // `cleared` so the opening pass can be steered inside the disk the helix will open -- but
  // the helix only runs if a pass is KEPT and consumes the entry. When the opening pass cuts
  // nothing (its default heading faced cleared ground) the entry stayed pending, the next
  // re-seed overwrote it, and the disk stayed credited: three orphan disks, 182.8 mm2 of
  // phantom credit on the tray, diagnostics reporting clean over standing stock. Now the
  // belief before the fold is kept; a pass that does not consume the entry hands the belief
  // back, and the disk is credited again only at the moment a kept pass emits the entry.
  let pendingSeed: { disk: Loops; before: Loops } | null = null
  // WO-1178: the opening pass of a seed starts on the disk's inner circle at the bottom,
  // heading in the milling sense, and used to have no second choice: when that heading faced
  // ground already cleared it cut nothing, the pass was dropped and the entry orphaned (the
  // tray mechanism above). Try the default first -- byte-identical whenever it cuts -- then
  // the other seven positions round the circle, each heading tangent in the same milling
  // sense (material outward on the climb/conventional side), and take the first that cuts.
  const seedStart = (centre: Pt, seedRadius: number, belief: Loops): { pos: Pt; dir: Pt } => {
    const r = Math.max(seedRadius - toolRadius, 0)
    const probeStep = tolerance * 2
    const candidates: { pos: Pt; dir: Pt }[] = []
    for (let k = 0; k < 8; k++) {
      const phi = -Math.PI / 2 + k * (Math.PI / 4)
      const n = { x: Math.cos(phi), y: Math.sin(phi) }
      const pos = { x: centre.x + r * n.x, y: centre.y + r * n.y }
      const dir = forwardTravel ? { x: -n.y, y: n.x } : { x: n.y, y: -n.x }
      candidates.push({ pos, dir })
    }
    for (const c of candidates) {
      const to = { x: c.pos.x + c.dir.x * probeStep, y: c.pos.y + c.dir.y * probeStep }
      if (tool.cutArea(c.pos, to, belief).area > 0) return c
    }
    return candidates[0]
  }

  // Re-seed: when the engage frontier is exhausted, drop a fresh entry in the largest
  // leftover uncut pocket of the centre region. Stop when too little remains, or when a
  // cycle made no progress (guards against an unmachinable sliver looping forever).
  // A closed pocket needs enough room to establish another interior entry.
  // An outside-in region does not: it can roll in from already-cleared space
  // and must keep cleaning accessible slivers. Using one full tool-disk area
  // for both cases declared small but dangerous standing islands "complete."
  const MIN_RESEED_AREA = sideStart
    ? Math.max(tolerance * tolerance, arcTol * arcTol)
    : Math.PI * toolRadius * toolRadius
  let lastReseedRemaining = Infinity
  let lastThickArea = Infinity
  // Why the reseed loop stopped. 'complete' is the normal end (too little material left
  // to matter); anything else with meaningful residual is surfaced via stats.aborted.
  let reseedStop: 'complete' | 'no-progress' | 'no-entry' | null = null
  // WO-465: prevention and WO-464's buffer feed ONE account of what this run declined to
  // make a region of. The stage on each record says which of the two declined it.
  const droppedSliverRegions: DroppedComponent[] = [...prevented.dropped]
  type ReseedEntry =
    | { mode: 'interior'; pt: Pt; seedDisk: Loops; seedRadius: number; hole?: true }
    | { mode: 'side'; pt: Pt; clearPoint: Pt; dir: Pt; frontier: Loops }
  const reseed = (): ReseedEntry | null => {
    const remaining = difference(cutRegion, cleared)
    // NET material quantity (signed sum; holes subtract). The remaining region of a
    // large pocket is the outer loop plus the HOLES the cleared spirals punch in it;
    // totalArea (absolute sum) counted those holes as positive material, so "remaining"
    // GREW as material was removed and the no-progress guard below killed reseeding
    // (silent early termination at >=400x266mm; proven by _clipper-large-coord-probe).
    const remArea = netArea(remaining)
    // WO-409: `remaining` is TOOL-CENTRE space (cutRegion is the feature inset by
    // R), so a lobe tip that still holds a cutter's width of real material reads
    // as a sliver here and one summed threshold declared the region complete -
    // the finishing contour then rode through the tip buried (Full_Suite 3D
    // Rough 2: 8-9 mm at 100-110% per lobe). Complete means: no REAL leftover
    // thicker than the stepover anywhere the tool can reach (the rim the
    // finishing contour is designed to take). Thinner leftovers keep the old
    // centre-space rule.
    const reachable = offsetClosed(cutRegion, toolRadius, arcTol)
    const realLeft = difference(reachable, cleared)
    const thick = offsetClosed(realLeft, -(stepOverDistance / 2), arcTol)
    const thickLeft = thick.length > 0 && Math.abs(netArea(thick)) > arcTol * arcTol
    if (!thickLeft && remArea < MIN_RESEED_AREA) { reseedStop = 'complete'; return null }
    if (typeof process !== 'undefined' && process.env.RESEED_DEBUG) console.warn(`[reseed-dbg] remArea ${remArea.toFixed(1)} last ${lastReseedRemaining.toFixed(1)} thickLeft ${thickLeft} thick ${thick.length ? Math.abs(netArea(thick)).toFixed(2) : 0} lastThick ${lastThickArea.toFixed(2)} MIN ${MIN_RESEED_AREA.toFixed(1)}`)
    if (remArea > lastReseedRemaining - MIN_RESEED_AREA && !(thickLeft && lastThickArea - Math.abs(netArea(thick)) > arcTol * arcTol)) { reseedStop = 'no-progress'; return null }
    lastReseedRemaining = Math.min(lastReseedRemaining, remArea)
    lastThickArea = thickLeft ? Math.abs(netArea(thick)) : 0
    // An open external region stays outside-in for its entire life. When one
    // frontier exhausts, reposition through already-cleared air and roll in at
    // another bounded edge. Never turn an external cleanup into an interior
    // helix merely because one side of the frontier finished first.
    // (WO-402b) ... unless the roll-in it finds is not actually clear: the side
    // reseed's descent point must have the WHOLE cutter disk inside `cleared` (the
    // 2D proof of the live-stock check the 3D emitter applies later). A clear point
    // whose disk still stands in material is a slot entry in disguise (ring 11:
    // (95.66, 5.13) inside the stock, over-cut, region abort, stock-edge lap at full
    // width). Then the region takes the interior entry it would have taken before
    // 29727448 (helix where it fits, else the loud plunge) - the 1962cecd behaviour.
    if (sideStart) {
      const side = getEngagePoint(
        cleared,
        tool,
        toolRadius,
        optimal,
        tolerance,
        stepOver,
        remaining,
        arcTol,
        millingDirection,
        engageInsideRegion,
      )
      if (side && engageInsideRegion(side.pt) && landingDiskUncutFraction(side.clearPoint, cleared, toolRadius, arcTol) <= SIDE_RESEED_CLEAR_UNCUT_MAX) {
        return { mode: 'side', ...side, frontier: remaining }
      }
      if (side) {
        console.warn(`[side-entry] reseed roll-in at (${side.pt.x.toFixed(2)}, ${side.pt.y.toFixed(2)}) is not proven clear at its descent point -- interior entry instead (ADR-0003)`)
      }
    }
    const entry = findSeed(remaining)
    if (entry) {
      // Prove the REGION cannot fit the exact shared descent floor. The capacity search below
      // is deliberately only a measurement: it returns a lower-bound estimate and may stop
      // with a 0.025 mm bracket, so comparing that estimate to the floor could discard an
      // actually legal 0.200 mm re-seed. Fixed-radius findStartPointIn samples minInscribe
      // exactly, independent of the configured helix radius carried by `entry`.
      const minimumLegalEntry = findStartPointIn(
        remaining,
        cutTree,
        MIN_DESCENT_HELIX_RADIUS,
        toolRadius + MIN_DESCENT_HELIX_RADIUS,
        toolRadius,
        arcTol,
      )
      if (!minimumLegalEntry) {
        // WO-1178 (WO-430 "machined wins where the material is tool-enterable"): a leftover
        // that holds no legal helix is not yet unenterable -- it may be enterable from the
        // SIDE, rolling in from the cleared stock beside it with the same bounded engage the
        // outside-in mode uses (WO-409's rung below). That rung was only ever reached when no
        // interior entry was found at all, so a real sliver in the open field -- the seam where
        // two ring fronts meet, 0.86 mm2 and 1.8 mm thick on SquareIsland, beyond the engage
        // walker's reach from any wall -- was written off as unenterable and left standing while
        // the diagnostics read clean. Roll in first; only what no roll-in reaches is dropped.
        const sideNibble = getEngagePoint(cleared, tool, toolRadius, optimal, tolerance, stepOver, remaining, arcTol, millingDirection, engageInsideRegion)
        if (sideNibble && engageInsideRegion(sideNibble.pt) && landingDiskUncutFraction(sideNibble.clearPoint, cleared, toolRadius, arcTol) <= SIDE_RESEED_CLEAR_UNCUT_MAX) {
          console.warn(`[reseed] leftover at (${entry.pt.x.toFixed(2)}, ${entry.pt.y.toFixed(2)}) holds no legal helix -- rolling in from the cleared side at (${sideNibble.pt.x.toFixed(2)}, ${sideNibble.pt.y.toFixed(2)}) instead of leaving it standing (WO-1178)`)
          return { mode: 'side', ...sideNibble, frontier: remaining }
        }
        const capacity = findStartPointIn(
          remaining,
          cutTree,
          Math.max(tolerance * AP.sampling.seedSearchTolerances, arcTol),
          undefined,
          toolRadius,
          arcTol,
        )
        const largestFittingEntryRadius = Math.max((capacity?.seedRadius ?? toolRadius) - toolRadius, 0)
        // This is the re-seed buffer Operator chose for WO-464. If the largest entry that fits
        // anywhere in `remaining` is below the emitter's shared floor, every component is
        // unenterable by construction. Do not credit a plunge disk the machine will refuse
        // and do not attach an entry; leave the components in the existing residual account
        // and end this walk normally. The feature's FIRST entry above is deliberately
        // unchanged.
        for (const loops of materialComponents(remaining, arcTol)) {
          droppedSliverRegions.push({ loops, toolCentreArea: Math.abs(netArea(loops)), largestEntryRadius: largestFittingEntryRadius, stage: 're-seed' })
        }
        reseedStop = 'complete'
        return null
      }
      return { mode: 'interior', ...entry }
    }
    // WO-409: no helix room left (a tool-width lobe tip, a waist) - roll in from
    // the CLEARED interior with the same bounded engage the outside-in mode uses
    // (getEngagePoint: tool centre in cleared air, the first bite sized to the
    // load). This is the nibble the stepper already knows how to carry; it was
    // only ever offered to outside-in regions.
    const rollIn = getEngagePoint(cleared, tool, toolRadius, optimal, tolerance, stepOver, remaining, arcTol, millingDirection, engageInsideRegion)
    if (rollIn && engageInsideRegion(rollIn.pt) && landingDiskUncutFraction(rollIn.clearPoint, cleared, toolRadius, arcTol) <= SIDE_RESEED_CLEAR_UNCUT_MAX) {
      return { mode: 'side', ...rollIn, frontier: remaining }
    }
    reseedStop = 'no-entry'
    return null
  }
  // The top-level loadSetpoint (default 0.95) wins over any stepper.loadSetpoint so the
  // ProcessParams knob is authoritative; a per-call stepper override is still respected
  // when the top-level field is left undefined.
  // WO-3042: the steering wobble smoothing (WO-3029 causes A, B, C), one switch, ships OFF.
  const smoothSteering = ADAPTIVE_MOTION_SWITCHES.steeringSmoothing
  const stepper = createStepper(tool, {
    ...params.stepper, materialSide: materialSideFor(millingDirection), loadSetpoint: params.loadSetpoint ?? params.stepper?.loadSetpoint ?? AP.steering.loadSetpoint,
    ...(smoothSteering ? { smoothing: {
      gain: STEERING_SMOOTHING.correctionGain,
      maxCorrection: STEERING_SMOOTHING.maxCorrectionFraction * Math.PI / AP.steering.maxDeflectionDivisor,
    } } : {}),
  })
  // WO-439 fix 2: the walker measures its bite inside targetRegion -- the material a
  // roughing pass may actually take. What that excludes is exactly what the raw disk bite
  // used to count and no pass can ever remove: the finishing-stock rim outside the tool's
  // reach, the retained islands, and the stock beyond the feature. Measured on the corpus:
  // clipping to cutRegion (the CENTRE region) instead cuts too much out -- it hides the
  // real wall band a pass CAN still take, and residual grew on four fixtures. Dilating
  // cutRegion by the tool radius gives targetRegion, so this is that reach, exactly.
  // WO-443: with wallFinish on, walkerRegion is that same reach LESS the band the wall
  // finishing contour is credited with; with it off, walkerRegion IS targetRegion.
  let walker = createEngagementWalker(cutRegion, tool, forwardTravel, walkerRegion)

  // Progress signal (B6): residual-area COVERAGE, frac = clearedSoFar / totalCutArea.
  // totalCutArea is computed ONCE here from cutRegion (no per-pass clipper op). The
  // per-pass numerator accumulates each pass's cumulativeCuttingArea (already computed
  // by the inner step loop for the keep-pass gate) -- this approximates cleared coverage
  // WITHOUT any new union/difference/intersection inside the pass loop (B7 would have to
  // undo that cost). It over-counts where passes overlap, so frac is clamped to a running
  // max and bounded to [0,1] so the bar is monotonic non-decreasing and never exceeds 1.
  const totalCutArea = Math.abs(netArea(stockRegion))
  let clearedAreaAcc = 0
  let progressRunningMax = 0
  const emitProgress = () => {
    if (!onPassProgress) return
    const frac = totalCutArea > 0 ? clearedAreaAcc / totalCutArea : 0
    const clamped = Math.min(Math.max(frac, progressRunningMax), 1)
    progressRunningMax = clamped
    onPassProgress(clamped)
  }

  // WO-439 diagnosis probe. Runs ONLY when the census is enabled; nothing in the engine
  // reads its result. `all` = uncut material still standing within one tool DIAMETER of p;
  // `thick` = the part of it thicker than half a stepover (the reseed's own "thick" test),
  // i.e. real stock the tool could still take rather than the finishing rim.
  const remainingNear = (p: Pt, clearedNow: Loops): { all: number; thick: number } => {
    const near = intersection(difference(cutRegion, clearedNow), diskPath(p, toolDia, arcTol))
    const all = Math.abs(netArea(near))
    if (all <= 0) return { all: 0, thick: 0 }
    const thick = offsetClosed(near, -(stepOverDistance / 2), arcTol)
    return { all, thick: thick.length ? Math.abs(netArea(thick)) : 0 }
  }

  const passes: AdaptivePass[] = []
  const finishClearedRegions: ('inside' | 'outside')[] = []
  const finishPassOffsets: ('wall')[] = []
  // WO-449: one gated connection per finish pass, parallel to the arrays above.
  const finishApproaches: (FinishApproach | undefined)[] = []
  let finishFitRegion: Loops | undefined
  const wallCleanupDirectionFallback: WallCleanupDirectionFallback = { rejected: false }
  // WO-2787 fix round 7: THE GAP-FILL A REPOSITION LEAVES BEHIND. With the wall finish on and
  // cleanup as-we-go, every stretch of wall no wall ride covered is ridden at the end of
  // roughing by the WO-447 gap-fill, at the wall-follow role, and reached by its own travel.
  // So a kept-down wall ride that covers wall nothing has covered yet SPARES that later ride,
  // and a lift that leaves the wall standing PAYS it. Measured on gt_fix8 (floor replay,
  // finishing feed = cut): a lift priced 3.6 s under the wall arc ran 1194.85 ms slower as a
  // whole program, because the gap-fill then rode the 19.6 mm of wall the arc would have
  // covered, on every level. The time model reads the new coverage through the gap-fill's own
  // bookkeeping (creditWallRide over the stream so far), for the main pass loop only: the
  // gap-fill and the cleanup contour run after the gaps are fixed. Rides a later pass would
  // also have covered are not foreseen.
  const gapFillCanRun = !!params.wallFinish && !!params.wallCleanupAsWeGo && !singleWallPass && wallBandContour.length > 0
  const coverTables = gapFillCanRun && params.repositionTime ? cutRegion.map(buildLoopArcTable) : []
  const coverFillable = wallBandContour.map(loop => cutRegion.indexOf(loop)).filter(li => li >= 0)
  const coverSoFar: [number, number][][] = cutRegion.map(() => [])
  const coverTol = Math.max(arcTol * AP.sampling.wallTolArcTols, toolRadius * AP.sampling.wallTolToolRadii)
  let coverScanned = 0
  const newWallCoverMm = (rides: Pt[][], extra: Pt[][]): number => {
    if (wallCleanupDirectionFallback.rejected) return 0
    for (; coverScanned < passes.length; coverScanned++) {
      const pass = passes[coverScanned]
      if (pass.type === 'wallfollow' && pass.points.length >= 2) creditWallRide(coverSoFar, pass.points, cutRegion, coverTables, coverTol, arcTol)
    }
    const before = coverSoFar.map(spans => spans.slice())
    for (const ride of extra) if (ride.length >= 2) creditWallRide(before, ride, cutRegion, coverTables, coverTol, arcTol)
    const after = before.map(spans => spans.slice())
    for (const ride of rides) if (ride.length >= 2) creditWallRide(after, ride, cutRegion, coverTables, coverTol, arcTol)
    let mm = 0
    for (const li of coverFillable) {
      const per = coverTables[li].per
      mm += Math.min(mergedSpanLength(after[li]), per) - Math.min(mergedSpanLength(before[li]), per)
    }
    return mm
  }
  const mainRepositionTime: RepositionTimeModel | null = params.repositionTime
    ? (gapFillCanRun ? { ...params.repositionTime, wallGapMm: newWallCoverMm } : params.repositionTime)
    : null
  let totalPoints = 0
  let firstEngagePoint = true
  // WO-410 WALKER/STEPPER ENGAGE CONTRACT (the termination the phantom disk used to fake):
  // a pass PROGRESSES only if it removed at least ONE ENGAGE-BAND BITE (maxBite -- the
  // largest bite the walker may hand the stepper, 1.5 x optimal x its step). That is the
  // minimum bite worth a pass: anything under it is crumb-polishing that can never finish
  // a region (measured on BootL: dust passes of ~0.02 mm^2 burned all 5000 passes while
  // 285 mm^2 of tool-enterable pockets waited for a re-seed that never came). When the
  // walker has travelled one FULL LAP of the frontier boundary without a progressing
  // pass, the engage frontier is EXHAUSTED: stop walking and re-seed (roll-in/interior
  // entries take real load-setpoint bites; reseed's no-progress guard then terminates
  // the region honestly). Without this, honest belief re-engages forever on wall-rim
  // crumbs (measured: 5000 passes, 9-48 s/level).
  // WO-3030 (switch, default OFF): both keep-down cap sites read one MD-119 form.
  const engageMoveDistance = adaptiveEngageMoveDistance('walker', stepOverDistance, tolerance, arcTol,
    adaptiveKeepDownCapPolicy(ADAPTIVE_MOTION_SWITCHES.keepDownCapForm))
  // The walker's UPPER band edge: the most uncut material it may hand a fresh pass.
  const maxEngageBite = AP.caps.engageBandBiteFactor * optimal * engageMoveDistance
  // The smallest disk bite that counts as stock rather than a belief sliver (2% of the band
  // ceiling): the floor the walker was handed before WO-1178 raised its START floor to
  // minPassBite below. The ride-on rule's stock-ahead proof keeps this lower number on
  // purpose -- a ride is continued when any real stock stands one radius ahead, while a fresh
  // pass is only PLANTED where a progressing bite (minPassBite) is on offer.
  const walkerMinBite = AP.caps.walkerMinBiteFraction * maxEngageBite
  // WO-439 fix 3 -- THE PROGRESS FLOOR MUST BE REACHABLE. It used to BE maxEngageBite:
  // the identical expression, to the digit (0.3529 mm^2 at canonical settings). A fresh
  // pass may start standing in at most maxEngageBite of material, so the only way to clear
  // a floor set AT that ceiling was to TRAVEL -- which a pass that starts on the wall and
  // honestly skims a short rim cannot do. Every such pass was scored non-progressing,
  // drove the fruitless-lap odometer, and ended in a reseed (step-1 census: ALL extra
  // entries on Bar 8/8 and Triangle 10/10). The contract itself is NOT deleted -- it is
  // what stops the measured 5000-pass crumb loop (see the WALKER/STEPPER ENGAGE CONTRACT
  // note above: BootL dust passes of ~0.02 mm^2 burning every pass slot). The floor now
  // sits at a named fraction of the ceiling, still ~4x above that measured dust.
  const MIN_PASS_BITE_RATIO = AP.caps.minPassBiteRatio
  const minPassBite = MIN_PASS_BITE_RATIO * maxEngageBite
  let lastProgressOdometer = 0
  let bitesSinceProgress = 0 // WO-439 census: in-band bites offered since the last progressing pass
  // Phase A (diagnostic, inert): the boundary span the engage-walker traversed to reach
  // the NEXT pass's start. Captured at the end of one iteration, attached to the link that
  // the next iteration's appendCutPass emits. Does NOT influence emit/jumpType/geometry.
  let pendingBoundarySpan: Pt[] | null = null
  // Side entry starts AT the in-band boundary point (like a between-pass start): the walker
  // tangent is the initial direction, and the first bite is a normal bounded engagement, not
  // a plunge. Default entry starts inside the seed disk and cuts outward (unchanged).
  const firstSeedStart = sideStart ? null : seedStart(startPoint, start!.seedRadius, cleared)
  let toolPos: Pt = sideStart
    ? { x: sideStart.pt.x, y: sideStart.pt.y }
    : firstSeedStart!.pos
  let toolDir: Pt = sideStart ? sideStart.dir : firstSeedStart!.dir
  let overCutStreak = 0
  let aborted: string | undefined

  // WO-1178: the unit direction of the cutRegion wall nearest `p`, oriented with `heading`
  // (null when no wall is near or the heading is square to it, i.e. there is no travel sense
  // along the wall). The ride-on rule below steers a pass along the wall it just touched; the
  // tangent it rides is the wall's own, never the leaning-in heading that reached it.
  const wallTangentAt = (p: Pt, heading: Pt): Pt | null => {
    let bestD2 = Infinity
    let dir: Pt | null = null
    for (const { lp: loop, g } of nearestEdgeCandidates(p, cutRegion)) {
      const a = loop[g]
      const b = loop[(g + 1) % loop.length]
      const { distSq } = closestOnSegment(a, b, p)
      if (distSq >= bestD2) continue
      const L = Math.hypot(b.x - a.x, b.y - a.y)
      if (L <= 1e-9) continue
      bestD2 = distSq
      dir = { x: (b.x - a.x) / L, y: (b.y - a.y) / L }
    }
    if (!dir) return null
    const dot = dir.x * heading.x + dir.y * heading.y
    if (Math.abs(dot) < 1e-6) return null
    return dot >= 0 ? dir : { x: -dir.x, y: -dir.y }
  }

  // WO-1178 ROOT CAUSE 1 (Operator's Bar finding, 2026-09-02: "why the sharp corners at these
  // wall follow exits and entries?"). Measured on the Bar at the project's settings
  // (src/tests/evidence/WO-1178/_probe/corner-angles.mjs): every ring reached a wall at
  // 8-66 degrees to it and was CLIPPED there, and the ride that followed (the ride-on slide or
  // the cusp exit ride) started along the wall's tangent -- so the join turned by the whole
  // arrival angle at one vertex. Leaving, a start the walker had planted ON the wall was handed
  // to the stepper with the wall as its heading and the stepper's full pi/4 clamp for its first
  // 0.2 mm step: 13-45 degrees in one vertex (45.0 on eleven of the Bar's passes, the clamp
  // itself). Neither join was load-driven; both are the geometry of a clip and a clamp.
  //
  // THE FIX, both ends of a wall ride, both under the cut's own cap (`optimal`):
  //  - ARRIVAL: when the step ahead would bring the ring within a fillet's reach of the wall it
  //    is heading into, the ring is steered onto a tangent arc that meets the wall tangentially
  //    (radius WALL_FILLET_R, shrunk only to fit the wall segment or the distance left), every
  //    sub-step measured against the physical belief and refused over `optimal` -- the same
  //    clip then happens, exactly as before.
  //  - DEPARTURE: for the first fillet's reach after a wall contact (a planted start on the
  //    wall, a ride-on slide, an arrival fillet) the heading may turn by at most step / R per
  //    step, so the tool leaves the wall on an arc of radius >= R; a limited step that would
  //    cut nothing or over `optimal` yields to the stepper's own step, as before.
  // The fillet is never tighter than a quarter of the tool's radius and never used against a
  // vertex (a corner apex has no single wall to blend into): those joins stay as they were.
  const WALL_FILLET_R = toolRadius
  const WALL_FILLET_MIN_R = toolRadius / AP.sharpening.wallFilletMinRadiusDivisor
  const WALL_FILLET_MIN_TURN = AP.sharpening.wallFilletMinTurnDeg * Math.PI / 180
  const wallJoinTol = Math.max(arcTol * AP.sampling.wallTolArcTols, toolRadius * AP.sampling.wallTolToolRadii)
  const nearestWallSegment = (p: Pt): { dir: Pt; foot: Pt; dist: number; t: number; segLen: number } | null => {
    let best: { dir: Pt; foot: Pt; dist: number; t: number; segLen: number } | null = null
    // WO-3024: only the edges that could be nearest, in the full scan's order (same answer).
    for (const { lp: loop, g } of nearestEdgeCandidates(p, cutRegion)) {
      const a = loop[g]
      const b = loop[(g + 1) % loop.length]
      const L = Math.hypot(b.x - a.x, b.y - a.y)
      if (L <= 1e-9) continue
      const { clp, distSq } = closestOnSegment(a, b, p)
      if (best && distSq >= best.dist * best.dist) continue
      const dir = { x: (b.x - a.x) / L, y: (b.y - a.y) / L }
      const t = ((clp.x - a.x) * dir.x + (clp.y - a.y) * dir.y) / L
      best = { dir, foot: clp, dist: Math.sqrt(distSq), t, segLen: L }
    }
    return best
  }
  interface WallFillet { points: Pt[]; dirs: Pt[]; areas: number[]; apds: number[]; tangent: Pt }
  // The fillet radius ladder, largest first: the tool's radius, then half, then a quarter (the
  // loopback fillet's own radius at the default 25%). A tighter fillet turns off the wall sooner
  // and meets less of the thickening rim, so it is what the load allows where the full radius
  // would exceed the cap. 'later' = the full-radius fillet has not begun yet (a smaller radius
  // begins later still, so the ladder stops there); null = no radius fits or proves.
  const WALL_FILLET_LADDER = AP.sharpening.wallFilletLadderDivisors.map(divisor => WALL_FILLET_R / divisor)
  const planWallFillet = (from: Pt, heading: Pt, step: number, clearedNow: Loops): WallFillet | null => {
    for (const radius of WALL_FILLET_LADDER) {
      const fit = planWallFilletAt(from, heading, step, clearedNow, radius)
      if (fit === 'later') return null
      if (fit) return fit
    }
    return null
  }
  const planWallFilletAt = (from: Pt, heading: Pt, step: number, clearedNow: Loops, radius: number): WallFillet | null | 'later' => {
    const w = nearestWallSegment(from)
    if (!w || w.t <= 1e-6 || w.t >= 1 - 1e-6) return null // the nearest wall point is a vertex
    const d = w.dist
    if (d <= 1e-9) return null
    const n = { x: (w.foot.x - from.x) / d, y: (w.foot.y - from.y) / d }
    if (heading.x * n.x + heading.y * n.y <= 1e-9) return null // not heading into this wall
    let tw = w.dir
    let cosT = heading.x * tw.x + heading.y * tw.y
    if (cosT < 0) { tw = { x: -tw.x, y: -tw.y }; cosT = -cosT }
    cosT = Math.min(1, cosT)
    const theta = Math.acos(cosT)
    if (theta < WALL_FILLET_MIN_TURN) return null // already tangent enough
    const sinT = Math.sin(theta)
    const oneMinusCos = 1 - cosT
    // Room along the wall in the ride sense: from the foot to the segment's end vertex.
    const room = (tw.x * w.dir.x + tw.y * w.dir.y) >= 0 ? (1 - w.t) * w.segLen : w.t * w.segLen
    let rf = Math.min(radius, room / sinT)
    let straight = (d - rf * oneMinusCos) / sinT
    if (straight < 0) { rf = d / oneMinusCos; straight = 0 }
    if (rf < WALL_FILLET_MIN_R || rf * sinT > room + 1e-9) return null
    if (straight > step) return 'later' // the fillet begins beyond this step: not yet
    const points: Pt[] = []
    const dirs: Pt[] = []
    const areas: number[] = []
    const apds: number[] = []
    let prev = from
    const take = (p: Pt, dir: Pt): boolean => {
      if (isOutsideCutRegion(p, cutTree) && distToLoops(p, cutRegion) > SKIM_ON_WALL_EPS) return false
      const m = tool.cutArea(prev, p, clearedNow)
      if (m.areaPerDist > optimal) return false
      points.push(p); dirs.push(dir); areas.push(m.area); apds.push(m.areaPerDist)
      prev = p
      return true
    }
    const P0 = straight > 1e-9
      ? { x: from.x + heading.x * straight, y: from.y + heading.y * straight }
      : from
    if (straight > 1e-9 && !take(P0, heading)) return null
    const cross = heading.x * tw.y - heading.y * tw.x
    const sgn = cross >= 0 ? 1 : -1
    const C = { x: P0.x - sgn * heading.y * rf, y: P0.y + sgn * heading.x * rf }
    const radial = { x: P0.x - C.x, y: P0.y - C.y }
    const foot0 = { x: P0.x + n.x * rf * oneMinusCos, y: P0.y + n.y * rf * oneMinusCos }
    const end = { x: foot0.x + tw.x * rf * sinT, y: foot0.y + tw.y * rf * sinT }
    const m = Math.max(1, Math.ceil(rf * theta / step))
    for (let k = 1; k <= m; k++) {
      const phi = sgn * theta * k / m
      const rv = rotate(radial, phi)
      const p = k === m ? end : { x: C.x + rv.x, y: C.y + rv.y }
      if (!take(p, k === m ? tw : rotate(heading, phi))) return null
    }
    let total = 0
    for (const a of areas) total += a
    if (total <= 0) return null
    return { points, dirs, areas, apds, tangent: tw }
  }
  // ── WO-1901: EACH REGION'S WALL RING IS RIDDEN BEFORE THE TOOL LEAVES THAT REGION ──────
  //
  // `cutRegion` can hold several disjoint regions -- the engagement pocket's two chambers,
  // split apart by the solid x=[40,50] divider once the feature is inset by the cutter.
  // The walk clears one, re-seeds into the next, and the finishing-contour driver below
  // used to ride EVERY ring afterwards. Riding a ring in a region the tool has already left
  // costs a retract, a rapid and a landing; and because the ring is seamed at the vertex
  // nearest wherever the tool ended up, that landing is the corner facing the region it came
  // from -- the one corner the engagement passes could not reach, so the 3D emitter's live
  // stock refuses a straight drop there and spirals down beside the standing material
  // instead (Operator ruling 2026-09-23: "we should NEVER be helixing into a corner for cleanup").
  //
  // So: when the re-seed is about to leave a region that has nothing left to cut, ride that
  // region's rings FIRST, while the tool is still at depth inside it. Everything about the
  // ride is the code below, unchanged -- the same gates, the same ladder, the same fold.
  // Only WHEN it runs moves, and with it WHERE the tool is when the connection is planned.
  const cleanupContourDone = new Set<number>()
  const cleanupRegions = groupCutRegionComponents(cutRegion)
  const cleanupRegionOfLoop = new Map<number, number>()
  for (let c = 0; c < cleanupRegions.length; c++) {
    cleanupRegionOfLoop.set(cleanupRegions[c].outer, c)
    for (const hole of cleanupRegions[c].holes) cleanupRegionOfLoop.set(hole, c)
  }
  /** Which region a point is in: the SMALLEST outer contour containing it, else the region
   *  owning the nearest loop (a cut can end a hair outside its own boundary on a facet). */
  const cleanupRegionAt = (p: Pt): number => {
    let best = -1
    let bestArea = Infinity
    for (let c = 0; c < cleanupRegions.length; c++) {
      const outer = cutRegion[cleanupRegions[c].outer]
      if (outer.length < 3 || pip2(p, outer) < 0) continue
      const a = loopArea(outer)
      if (a < bestArea) { bestArea = a; best = c }
    }
    if (best >= 0) return best
    const near = projectOnLoops(p, cutRegion)
    return near.loop >= 0 ? (cleanupRegionOfLoop.get(near.loop) ?? -1) : -1
  }
  /** Nothing a further re-seed could enter is left in this region. reseed()'s OWN 'complete'
   *  test (no real leftover thicker than half a stepover anywhere the tool reaches, and the
   *  centre-space remainder below its floor), restricted to this region's loops. A region
   *  that still holds material is never flushed -- its ring waits for the trailing driver,
   *  exactly as today, because riding a wall with stock still standing behind it is the
   *  WO-410 overload this engine refuses. */
  const cleanupRegionFinished = (c: number): boolean => {
    const loops: Loops = [
      cutRegion[cleanupRegions[c].outer],
      ...cleanupRegions[c].holes.map(i => cutRegion[i]),
    ]
    const reachable = offsetClosed(loops, toolRadius, arcTol)
    const thick = offsetClosed(difference(reachable, cleared), -(stepOverDistance / 2), arcTol)
    if (thick.length > 0 && Math.abs(netArea(thick)) > arcTol * arcTol) return false
    return netArea(difference(loops, cleared)) < MIN_RESEED_AREA
  }
  /** Called at the re-seed, with the point the walk is moving to. Rides the rings of the
   *  region the tool is leaving, when that region is done and the new seed is elsewhere. */
  const flushFinishedRegionCleanup = (nextPoint: Pt): void => {
    if (params.wallCleanupAsWeGo && !wallCleanupDirectionFallback.rejected) return
    if (cleanupRegions.length < 2) return
    const here = lastCut(passes)
    if (!here) return
    const from = cleanupRegionAt(here.points[here.points.length - 1])
    if (from < 0 || from === cleanupRegionAt(nextPoint)) return
    if (cleanupContourDone.has(cleanupRegions[from].outer)) return
    if (!cleanupRegionFinished(from)) return
    for (const li of [cleanupRegions[from].outer, ...cleanupRegions[from].holes]) {
      emitCleanupContour(cutRegion[li], li, true)
    }
  }

  let pasCount = 0
  // WO-1178: planted starts the landing gate refused and the walk skipped (see the catch in
  // the pass loop); past the bound the region is stopped as before.
  const MAX_UNSAFE_STARTS = AP.steering.maxUnsafeStarts
  let unsafeStarts = 0
  for (let pas = 0; pas < MAX_PASSES; pas++) {
    pasCount = pas + 1
    // B6 progress: report THIS feature's completion fraction at the top of each pass
    // (cleared-area coverage so far / total area to cut). Progress-only; no geometry.
    emitProgress()
    // Snapshot for the B8 stay-down gate: the cleared state as of the START of this pass.
    // The connection move appendCutPass builds runs BEFORE this pass cuts, but by the time
    // appendCutPass is called `cleared` has already folded this pass's swept corridor in --
    // validating the ride against that future state let rides slot through lanes the next
    // cut only clears AFTER the ride has already plowed them (measured: 3.1mm sustained on
    // the B8 island fixture). The ride must be judged against what the machine has
    // PHYSICALLY removed when it executes. (Reference copy is safe: `cleared` is only ever
    // reassigned, never mutated in place.)
    const clearedAtPassStart = cleared
    const gyro: Pt[] = Array.from({ length: AP.steering.headingSamples }, () => toolDir)
    toolDir = normalize(sumv(gyro))
    const engagePoint = toolPos
    const engageDirection = toolDir
    let passTravelDistance = 0
    const cycleCellSize = Math.max(tolerance * AP.sampling.cycleCellTolerances, arcTol * AP.sampling.cycleCellArcTols)
    const cycleVisits = new Map<string, { distance: number; direction: Pt }>()
    const cycleKey = (point: Pt): string => (
      `${Math.round(point.x / cycleCellSize)},${Math.round(point.y / cycleCellSize)}`
    )
    cycleVisits.set(cycleKey(engagePoint), { distance: 0, direction: engageDirection })
    stepper.resetHistory()

    const passToolPath: Pt[] = [toolPos]
    let toClearPath: Pt[] = [toolPos]
    let cumulativeCuttingArea = 0
    let deflectionAngle = Math.PI
    let isOutside = false
    // WO-439 census (write-only; never read by any decision below).
    let endReason: PassEndRecord['reason'] = 'max-points'
    let endDetail = ''
    let endDistToBoundary = 0
    let skimVerdict = 'no-clip'
    // WO-1178 ride-on accounting: how far this pass has ridden a wall with its load under the
    // wall's own tapered target (minCut). Reset by any productive step; bounds a ride that a
    // belief sliver, not stock, is carrying.
    let lowLoadRideLen = 0
    let slidOnWall = false
    // WO-1178 root cause 1: the last wall contact this pass is departing from (null once the
    // tool is a fillet's reach away from it).
    let departAnchor: Pt | null = null
    // The departure fillet off a planted wall start: how many leading points after the start
    // belong to the wall ride's tail (emitted as a 'lead'), and whether that run is still
    // being extended.
    let departHeadCount = 0
    let departHeadOpen = false
    let departRadius = WALL_FILLET_R
    // WO-1178: this pass's start was refused by the landing gate and the pass was skipped.
    let skippedStart = false
    // The wall-fillet samples of this pass: cleanPathKeeping never merges them away.
    const filletPoints = new Set<Pt>()

    for (let i = 0; i < MAX_POINTS_PER_PASS; i++) {
      totalPoints++
      toolDir = normalize(sumv(gyro))

      const distToBoundary = distToLoops(toolPos, cutRegion)
      // WO-2850: away from wall transitions, steer from the last travelled
      // heading. Averaging five old headings here adds a second lag to the
      // stepper's deflection history and makes straight stock-edge cuts hunt
      // across the load band. Inside the wall-fillet reach, retain the wall
      // transition heading policy and its existing arrival/departure proofs.
      // WO-3057: only where WO-2850 measured the hunting -- a stock-outline
      // component (the 3D rougher's open stock edge, clearedSeed) -- and only
      // FREE_CUT_TRAVEL_HEADING_RADII clear of every wall. Everywhere else the
      // gyro average stands, as the approved 2D/3D quality records hold it.
      if (steersFreeCutsFromTravel && distToBoundary >= FREE_CUT_TRAVEL_HEADING_RADII * toolRadius) {
        toolDir = gyro[gyro.length - 1]
      }
      if (i === 0 && distToBoundary <= wallJoinTol) {
        departAnchor = toolPos
        // A pass that carries an entry opens with its helix, not with a wall ride's tail.
        departHeadOpen = !pendingEntry
      }
      endDistToBoundary = distToBoundary // WO-439 census: value at the point the pass stops on
      const distToEngagePoint = magnitude(sub(toolPos, engagePoint))
      const relDistToBoundary = AP.steering.boundaryTaperRadii * distToBoundary / toolRadius
      const minCut = optimal / AP.steering.minCutDivisor

      let targetArea = (relDistToBoundary > 1 || distToEngagePoint < toolRadius)
        ? optimal
        : relDistToBoundary * (optimal - minCut) + minCut
      // WO-3042 cause A: the engage point's full-load zone fades into the wall taper over
      // STEERING_SMOOTHING.engageFadeRadii instead of stepping at one tool radius, so a cut running
      // along that circle near a wall no longer sees its target halve and double step to step.
      if (smoothSteering && relDistToBoundary <= 1 && distToEngagePoint >= toolRadius) {
        const fade = (STEERING_SMOOTHING.engageFadeRadii * toolRadius - distToEngagePoint) / ((STEERING_SMOOTHING.engageFadeRadii - 1) * toolRadius)
        if (fade > 0) targetArea += Math.min(1, fade) * (optimal - targetArea)
      }

      // Adaptive step (scale-free port of FreeCAD's 4.0/deflectionAngle): tight turns
      // and wall/engage proximity -> small steps; straight runs -> up to toolRadius/2.
      let step: number
      if (distToBoundary < toolRadius || distToEngagePoint < toolRadius) step = tolerance * AP.steering.nearStepTolerances
      else if (Math.abs(deflectionAngle) > 1e-4) step = (AP.steering.turnStepTolerances * tolerance) / Math.abs(deflectionAngle)
      else step = tolerance * AP.steering.straightStepTolerances
      step = Math.min(Math.max(step, tolerance * AP.steering.minStepTolerances), toolRadius / AP.steering.maxStepRadiusDivisor)

      const r = stepper.findNextPoint(cleared, toolPos, toolDir, step, targetArea)
      if (r.blockedByMillingSide) {
        endReason = 'no-cut'
        endDetail = 'no admissible cutting heading on the requested milling side'
        break
      }
      let newToolPos = r.toolPos
      let newToolDir = r.toolDir
      deflectionAngle = r.deflectionAngle
      let area = r.area
      let areaPerDist = r.areaPerDist

      // WO-1178 root cause 1, DEPARTURE: within a fillet's reach of the wall just left, the
      // heading turns by at most step / R per step (against the LAST heading, not the gyro
      // average, so the bound is the path's real curvature). A limited step that cuts nothing
      // or leaves the region yields to the stepper's own step. The cap it is held to depends
      // on whose material it takes:
      //  - Leaving a PLANTED start (the pass's first steps, i = 0 on): measured on the Bar, the
      //    5.7-degree step off the wall reads 2.1-2.8 mm2/mm while the stepper's 45-degree step
      //    reads 1.46 -- the wall band beyond the start is thick, and it is the WALL RIDES'
      //    material by design (the walker never counts it; the cusp rides take it at their own
      //    1.5 x stepover cap). So these steps are the tail of the entry ride, not the ring's:
      //    they are held to the cusp cap, kept apart from the cut (`departHead`) and emitted
      //    by appendCutPass as a 'lead' (the fed engage off the wall, at cutting feed). The
      //    ring starts where the fillet ends.
      //  - Leaving a ride-on slide or an arrival fillet mid-pass: an ordinary step of the cut,
      //    under the cut's cap `optimal`.
      if (departAnchor) {
        if (magnitude(sub(toolPos, departAnchor)) >= AP.sharpening.departReachRadii * departRadius) {
          departAnchor = null
          departHeadOpen = false
        } else {
          const lastDir = gyro[gyro.length - 1]
          const turn = Math.atan2(lastDir.x * newToolDir.y - lastDir.y * newToolDir.x, lastDir.x * newToolDir.x + lastDir.y * newToolDir.y)
          let limited = false
          if (Math.abs(turn) > step / departRadius) {
            // The radius ladder: the current radius first, then tighter ones; a radius once
            // tightened stays tightened for the rest of this departure.
            const cap = departHeadOpen ? AP.caps.rideCapStepovers * stepOverDistance : optimal
            for (const radius of WALL_FILLET_LADDER) {
              if (radius > departRadius) continue
              const maxTurn = step / radius
              if (Math.abs(turn) <= maxTurn) { departRadius = radius; break } // the stepper's own step is within this radius
              const dir = rotate(lastDir, Math.sign(turn) * maxTurn)
              const pos = { x: toolPos.x + dir.x * step, y: toolPos.y + dir.y * step }
              if (isOutsideCutRegion(pos, cutTree)) continue
              const lm = tool.cutArea(toolPos, pos, cleared)
              if (lm.area > 0 && lm.areaPerDist <= cap) {
                newToolPos = pos; newToolDir = dir; area = lm.area; areaPerDist = lm.areaPerDist
                deflectionAngle = Math.sign(turn) * maxTurn
                // WO-3042 cause C: the stepper's momentum learns the turn taken (from the heading it was
                // handed), not the one it asked for. A mid-pass clamped step is an ordinary cut step of
                // the pass, so it is left to the pass's path cleanup like any other: pinned, every
                // +-step/R kink of a wall ride survived into the toolpath as a flip. The departure head
                // off a planted wall start stays pinned (appendCutPass counts it as the lead).
                if (smoothSteering) stepper.recordTakenDeflection(Math.atan2(toolDir.x * dir.y - toolDir.y * dir.x, toolDir.x * dir.x + toolDir.y * dir.y), lm.areaPerDist)
                if (!smoothSteering || departHeadOpen) filletPoints.add(pos)
                departRadius = radius
                limited = true
                break
              }
            }
          }
          if (departHeadOpen) {
            if (limited) departHeadCount++
            else departHeadOpen = false
          }
        }
      }

      // WO-1178 root cause 1, ARRIVAL: a tangent fillet onto the wall this step is heading into.
      if (distToBoundary < toolRadius) {
        const fillet = planWallFillet(toolPos, newToolDir, step, cleared)
        if (fillet) {
          for (let k = 0; k < fillet.points.length; k++) {
            const p = fillet.points[k]
            passTravelDistance += magnitude(sub(p, toolPos))
            cumulativeCuttingArea += fillet.areas[k]
            toClearPath.push(p)
            passToolPath.push(p)
            filletPoints.add(p)
            toolPos = p
            gyro.push(fillet.dirs[k]); gyro.shift()
            if (fillet.apds[k] >= minCut) lowLoadRideLen = 0
          }
          if (firstEngagePoint && toClearPath.length > 10) {
            cleared = expandCleared(cleared, toClearPath, toolRadius, arcTol)
            toClearPath = [toolPos]
          }
          // The tool stands ON the wall, heading along it: the next step is the ride-on skim
          // or the stepper's own peel-off, exactly as after a clip -- minus the kink.
          gyro.fill(fillet.tangent)
          overCutStreak = 0
          skimVerdict = 'fillet-arrival'
          slidOnWall = false
          departAnchor = toolPos
          departRadius = WALL_FILLET_R
          continue
        }
      }

      // Boundary reach: clip the move to the wall and remeasure.
      if (distToBoundary < toolRadius && isOutsideCutRegion(newToolPos, cutTree)) {
        isOutside = true
        const rp = segmentPathsIntersection([toolPos, newToolPos], cutRegion)
        newToolPos = rp ?? toolPos
        const m = tool.cutArea(toolPos, newToolPos, cleared)
        area = m.area; areaPerDist = m.areaPerDist
        // WO-410 STALLED WALL RIM -- THE DECISION (made once, here): the tool stands ON
        // the cutRegion wall, the load-optimal heading leans INTO it, and the boundary
        // clip degenerates to no move at all. The pass used to end there having emitted
        // nothing while expandCleared folded a phantom cutter disk (see expandCleared).
        // The honest alternatives were (a) tangent-skim the rim or (b) leave it standing.
        // DECIDED: skim, bounded -- step along the walker's heading (the wall tangent);
        // take the slide only if its measured load stays within the engine's stay-down
        // cap (1.5 x stepover effective width, the SAME cap every keep-down ride and
        // lead obeys), so the skim can never become a slot in disguise. A rim thicker
        // than the cap is NOT skimmed: it is left standing honestly -- the reseed
        // roll-in (getEngagePoint from the cleared side, WO-409 part 1) nibbles thick
        // rims at the load setpoint, and the finishing contour takes only what is
        // thinner than the cap. Never widen this to the over-cut ceiling (2 x optimal):
        // for stepOver 0.4 that is 80% of a slot, over the 75% engagement gate.
        skimVerdict = 'clip-moved' // WO-439: the clip produced a real move; no skim needed
        if (magnitude(sub(newToolPos, toolPos)) <= arcTol) {
          skimVerdict = 'skim-tried'
          const slide = { x: toolPos.x + toolDir.x * step, y: toolPos.y + toolDir.y * step }
          // WO-439 fix 1: the skim is judged by LOAD, not by a strict outside verdict.
          // A point sitting ON the wall and sliding ALONG it reads as "outside" to pip2's
          // ray cast (no on-boundary state) even though it has not left the region in any
          // physical sense. Only a slide that is outside AND further from the wall than
          // SKIM_ON_WALL_EPS (see its definition) is genuinely leaving; everything inside
          // that tolerance goes to the stay-down load cap below, which decides.
          const slideLeavesRegion = isOutsideCutRegion(slide, cutTree)
            && distToLoops(slide, cutRegion) > SKIM_ON_WALL_EPS
          if (!slideLeavesRegion) {
            const ms = tool.cutArea(toolPos, slide, cleared)
            // WO-1178 RIDE-ON: this slide is no longer only the stalled-rim rescue -- since the
            // ride-on rule below keeps a pass alive at every wall contact, this is how a pass
            // rides a wall INTO thickening stock (the corner rim) until the steering can hold
            // its tapered target again and peel off. Two bounds keep it from riding a belief
            // sliver along a whole wall: the ride is productive (load >= minCut, the wall's own
            // tapered target) OR the walker's own disk test sees stock one radius ahead
            // (diskBiteIn > the walker's minimum in-band bite); and a ride under minCut may
            // not exceed one tool diameter -- the disk proof above covers one radius of stock
            // ahead, and one more radius is the most a rim needs to reach the tapered target.
            const ahead = { x: toolPos.x + toolDir.x * toolRadius, y: toolPos.y + toolDir.y * toolRadius }
            const productive = ms.areaPerDist >= minCut
            const stockAhead = productive || tool.diskBiteIn(ahead, cleared, walkerRegion) > walkerMinBite
            const withinBudget = productive || lowLoadRideLen <= toolDia
            // The slide is a CUTTING move inside a cut pass, so its ceiling is the designed load
            // (`optimal`, GOOD-SPEC section 2: under is only time, over is forbidden) -- not the
            // 1.5 x stepover stay-down ride cap the stalled-rim skim used when it was the rare
            // rescue: as the routine wall ride it put 2.03 mm2/mm cuts on the Bar against a
            // 1.57 setpoint (wo1103-channel-entry). Over the designed load the pass ends here.
            if (ms.area > 0 && ms.areaPerDist <= optimal && stockAhead && withinBudget) {
              newToolPos = slide; newToolDir = toolDir; area = ms.area; areaPerDist = ms.areaPerDist; isOutside = false
              skimVerdict = 'skim-taken'
              slidOnWall = true
              departAnchor = slide // WO-1178: the peel-off from this ride is a fillet
              departRadius = WALL_FILLET_R
            } else if (fragCensus.enabled) {
              // WO-439: name the refusal. 'skim-nothing' = the tangent slide cut nothing;
              // 'skim-overload' = the rim is thicker than the stay-down cap, left standing.
              // WO-1178: 'skim-refused-crumb' = nothing but a sliver ahead; 'skim-refused-budget'
              // = a diameter of wall ridden under the tapered target without stock appearing.
              skimVerdict = ms.area <= 0
                ? 'skim-refused-nothing'
                : ms.areaPerDist > optimal
                  ? `skim-refused-overload(w=${ms.areaPerDist.toFixed(3)}>cap=${optimal.toFixed(3)})`
                  : !stockAhead ? 'skim-refused-crumb' : 'skim-refused-budget'
            } else {
              skimVerdict = 'skim-refused'
            }
          } else {
            skimVerdict = 'skim-refused-outside' // the tangent slide leaves the cut region
          }
        }
      }

      // Over-cut guard (port of FreeCAD): increment on an over-cut step, but RESET on
      // any normal step, so only CONSECUTIVE immediate over-cuts (a genuinely stuck
      // engage) abort the run -- an isolated high-engagement first step does not.
      if (areaPerDist > 2 * optimal) {
        overCutStreak++
        endReason = 'over-cut' // WO-439 census
        endDetail = `load=${areaPerDist.toFixed(3)}>2xoptimal=${(2 * optimal).toFixed(3)} streak=${overCutStreak}`
        break
      } else {
        overCutStreak = 0
      }

      toClearPath.push(newToolPos)
      // The very first pass clears incrementally so the engage walk sees fresh `cleared`.
      if (firstEngagePoint && toClearPath.length > 10) {
        cleared = expandCleared(cleared, toClearPath, toolRadius, arcTol)
        toClearPath = [newToolPos]
      }

      if (area > 0) {
        const stepDistance = magnitude(sub(newToolPos, toolPos))
        passTravelDistance += stepDistance
        cumulativeCuttingArea += area
        passToolPath.push(newToolPos)
        toolPos = newToolPos
        gyro.push(newToolDir); gyro.shift()
        // WO-1178 ride-on accounting (see the skim above): a productive step clears the
        // low-load odometer; a wall slide under the tapered target advances it.
        if (areaPerDist >= minCut) lowLoadRideLen = 0
        else if (slidOnWall) lowLoadRideLen += stepDistance
        slidOnWall = false
        // Later passes defer their swept-area union until the pass ends. A
        // closed pocket can therefore return to the same engage point and
        // repeat the lap forever, because the current lap is not in `cleared`
        // yet and every repeated step still looks like fresh cutting. Close
        // the pass only after a full tool-scale trip, back at its start, with
        // the same travel sense. The exact swept lap is unioned below; the
        // ordinary walker, reseed, cleanup, and residual gates still decide
        // whether any real material remains.
        const closesAtEngage = !firstEngagePoint
          && passTravelDistance >= Math.max(toolDia, stepOverDistance * AP.steering.orbitCloseStepovers)
          && magnitude(sub(newToolPos, engagePoint)) <= Math.max(tolerance * AP.steering.orbitCloseTolerances, step * AP.steering.orbitCloseSteps)
          && newToolDir.x * engageDirection.x + newToolDir.y * engageDirection.y >= AP.steering.orbitCloseDot
        const visitKey = cycleKey(newToolPos)
        const priorVisit = cycleVisits.get(visitKey)
        const closesRepeatedOrbit = !firstEngagePoint
          && priorVisit !== undefined
          && passTravelDistance - priorVisit.distance >= Math.max(toolDia, stepOverDistance * AP.steering.orbitCloseStepovers)
          && newToolDir.x * priorVisit.direction.x + newToolDir.y * priorVisit.direction.y >= AP.steering.orbitCloseDot
        if (closesAtEngage || closesRepeatedOrbit) {
          endReason = 'orbit-close' // WO-439 census
          endDetail = closesAtEngage ? 'back at engage point' : 'repeat of a visited cell'
          break
        }
        if (priorVisit === undefined) {
          cycleVisits.set(visitKey, { distance: passTravelDistance, direction: newToolDir })
        }
      } else {
        // WO-439 census: a no-cut break WHILE standing on the wall with the clip degenerate
        // is the stalled-rim ending, not an empty neighbourhood. Name them apart.
        endReason = isOutside ? 'boundary-stall' : 'no-cut'
        endDetail = isOutside ? skimVerdict : `stepper found no cutting direction (load target ${targetArea.toFixed(3)})`
        break // no material under the tool here -> end this pass
      }

      if (isOutside) {
        // WO-1178 RIDE-ON -- THE ONE CHANGE TO HOW RINGS ADVANCE. A pass used to end the
        // instant its tool centre touched the cut-region wall (38 of the Bar's 39 passes at the
        // project's settings), and the only survivor was WO-410's degenerate-clip skim. So a ring
        // arriving at a wall never rode it, a pass planted on a wall by the engage walker died
        // the first time the load-holding steering leaned into it (1-3 mm), every corner was
        // left as a triangle no ring entered, and that triangle was taken by ungated wall rides
        // at 87-94% of a slot (diagnosis.md under src/tests/evidence/WO-1178). the reference path's own
        // recorded corner passes ride one wall for about half their length and turn into the
        // corner one stepover deeper each time.
        //
        // Now a clipped move keeps the pass alive: the heading is reset to the wall's own
        // tangent in the travel sense, and the next step is the WO-410 skim -- the same slide,
        // the same stay-down load cap, plus the stock-ahead proof and the low-load budget added
        // there. The steering then does the rest with no corner-specific code: riding into a
        // thickening rim the load climbs to the tapered target, the stepper peels the tool off
        // the wall around the standing stock one stepover inside the previous ring, and the ring
        // lands on the far wall closer to the apex. A wall square to the heading (no travel
        // sense) still ends the pass exactly as before.
        const tangent = wallTangentAt(toolPos, newToolDir)
        if (tangent) {
          gyro.fill(tangent)
          isOutside = false
          skimVerdict = 'ride-on'
          slidOnWall = true
          departAnchor = toolPos // WO-1178: the peel-off from this wall is a fillet
          departRadius = WALL_FILLET_R
        } else {
          endReason = 'boundary-clip' // WO-439 census
          endDetail = skimVerdict
          break
        }
      }
    }

    // B6 progress accumulator: add the area this pass actually cut (already computed by the
    // inner loop). Used only to drive the next pass's progress emit; never affects geometry.
    clearedAreaAcc += cumulativeCuttingArea

    // Keep the pass only if it removed something significant. The first significant
    // pass of each region carries that region's entry (helix/plunge), emitted just
    // before the cut so the order is link(lift) -> entry -> spiral.
    // Fold every generated corridor so the planner advances exactly as before.
    // Material accounting and emitted motion must remain identical, however:
    // the old significance threshold marked a small corridor as cleared and
    // then omitted the motion, creating a real full-height spire. Retain every
    // geometrically nonzero cutting path, including the final cleanup sliver.
    if (toClearPath.length > 1) {
      cleared = expandCleared(cleared, toClearPath, toolRadius, arcTol)
    }
    // Keep by what the PASS travelled, not by what is left in `toClearPath`: the
    // first pass of a region folds that buffer into `cleared` every ten steps and
    // resets it to one point, so judging it here (5a4c1dd5, 2026-08-16) dropped
    // the whole opening spiral out of the entry helix - its material was marked
    // cleared, the motion was never emitted, the region reported "machined", and
    // the emitter fed straight from the helix to the next pass start through
    // standing stock (H pocket: a 722-point spiral lost, the right chamber left
    // 12 mm proud, a 15 mm full-width feed to the neck). WO-402d.
    const keepPass = passToolPath.length > 1 && cumulativeCuttingArea > 1e-12
    if (keepPass) {
      const cleaned = params.boundedPathCleanup
        ? boundedCleanPath(passToolPath, tolerance * AP.sampling.pathCleanTolerances, filletPoints)
        : cleanPathKeeping(passToolPath, tolerance * AP.sampling.pathCleanTolerances, filletPoints)
      // The departure fillet's points survive cleaning by construction (filletPoints), so the
      // run is still the first `departHeadCount` points after the start.
      const departHead = Math.min(departHeadCount, Math.max(0, cleaned.length - 2))
      try {
        cleared = appendCutPass(passes, cleaned, cleared, clearedAtPassStart, cutTree, cutRegion, toolRadius, helixRadius, stepOverDistance, arcTol, optimal, pendingEntry, pendingBoundarySpan, !!params.integralWallFollow, integralWallFollowLengthFactor, !!params.wallCleanupAsWeGo && !singleWallPass, params.loopbackFilletPct ?? 25, millingDirection, landingUncutCap, wallCleanupDirectionFallback, !!params.liftFallbackHelix, 'cut', null, departHead, exteriorAirAt, singleWallPass ? wallBandContour : null, false, mainRepositionTime, onAcceptedGraphRoute)
      } catch (err) {
        if (!(err instanceof UnsafeReentryError)) throw err
        // WO-1178 (attempt 3): AN UNREACHABLE START IS SKIPPED, NOT FATAL. The gate refused every
        // way onto THIS start (no clear disk, no proven shaft with a legal lead, no helix). That
        // is a fact about one planted start, not about the region: the walker has a whole
        // frontier of other bites ahead of it. The belief is handed back (the corridor this pass
        // would have cut is uncut again, so nothing is credited without motion), the pass counts
        // as no progress (so the fruitless-lap odometer and the re-seed still bound the walk),
        // and the walker moves on. A pass that carries the region's entry keeps the old stop:
        // its entry may already be in the stream. Only when this keeps happening is the region
        // stopped and reported partial (WO-400 / WO-097), exactly as before.
        if (!pendingEntry && unsafeStarts < MAX_UNSAFE_STARTS) {
          unsafeStarts++
          console.warn(`[lift-landing] start skipped (${unsafeStarts} of ${MAX_UNSAFE_STARTS}): ${err.message} -- belief handed back, the walker moves on (WO-1178)`)
          cleared = clearedAtPassStart
          skippedStart = true
        } else {
          // No safe way back into this region from here (WO-400): stop THIS region and report it
          // through stats.aborted (WO-097 partial-region accounting) instead of failing the whole
          // operation. Passes already appended stay; the material this pass would have taken is
          // still standing and is counted in the residual below.
          console.warn(`[lift-landing] region stopped: ${err.message}`)
          aborted = 'unsafe-re-entry'
          break
        }
      }
      if (pendingEntry && !skippedStart) {
        // WO-439 census: the entry actually planted, with the pass it opened.
        if (fragCensus.enabled) fragCensus.entries.push({ pass: pas, x: pendingEntry.point.x, y: pendingEntry.point.y, mode: pendingEntry.mode, radius: pendingEntry.radius })
        entries.push(pendingEntry); pendingEntry = null
        // WO-1178: the entry is emitted, so its helix really opens the seed disk -- credit it
        // now (a no-op when the opening pass kept the fold; the fold-back for a later stale
        // entry, WO-429, lands here).
        if (pendingSeed) { cleared = union(cleared, pendingSeed.disk); pendingSeed = null }
      }
    }
    // WO-1178 fix round: a DROPPED opening pass does not by itself hand the seed disk back.
    // The disk stays credited while its entry is pending so the engage walker can plant the
    // next pass on the disk's rim -- the pass that consumes the entry and really opens the
    // disk. A plunge seed (helixDiameter 0, radius = R) needs exactly that: its opening step
    // from the centre is a full-width slot, over-cut by construction, so the opening pass is
    // always dropped and the rim pass is the entry's real motion (reseedSliver.wo464: both
    // plunge re-seeds were lost, two chambers left standing, the region stopped as
    // no-progress). The hand-back happens where the entry is proven orphaned: at the next
    // re-seed (below) and at the end of the walk (after the loop), never earlier.
    pendingBoundarySpan = null

    // WO-439 census: record WHY this pass ended and what was left where it stopped.
    // Write-only; `cleared` here already holds this pass's swept corridor, so the probe
    // reports material the machine really left standing, not the stepper's stale belief.
    if (fragCensus.enabled) {
      const near = remainingNear(toolPos, cleared)
      fragCensus.passEnds.push({
        pass: pas,
        reason: endReason,
        detail: endDetail,
        x: toolPos.x,
        y: toolPos.y,
        distToBoundary: endDistToBoundary,
        travel: passTravelDistance,
        area: cumulativeCuttingArea,
        points: passToolPath.length,
        kept: keepPass,
        progressed: passToolPath.length > 1 && cumulativeCuttingArea > minPassBite,
        minPassBite,
        remainingNearEnd: near.all,
        remainingNearEndThick: near.thick,
      })
    }

    if (overCutStreak > AP.steering.maxOverCutStreak) { aborted = 'over-cut'; break }

    // Find where to start the next pass.
    // WO-410: did THIS pass progress (>= the walker's minimum engage bite)? Judged on
    // what the pass actually travelled and removed -- the same quantities keepPass uses.
    const passProgressed = !skippedStart && passToolPath.length > 1 && cumulativeCuttingArea > minPassBite
    let advanced: boolean
    let boundarySpan: Pt[] | null = null
    let walkerGaveUp: ReseedRecord['cause'] = 'walk-exhausted' // WO-439 census
    if (firstEngagePoint) {
      walker.moveToClosestPoint(toolPos)
      firstEngagePoint = false
      advanced = true
    } else {
      // Phase A: snapshot the walker location BEFORE the configured-direction walk so
      // the traversed boundary span can be recovered (inert; emit is unchanged).
      const spanStart = walker.getLocation()
      const moveDistance = engageMoveDistance
      const maxBite = maxEngageBite // same value as before; hoisted so minPassBite can name it
      // WO-1178 (WO-439): A START MUST OFFER THE BITE THAT COUNTS AS PROGRESS. The band's
      // floor used to be 2% of the ceiling (0.024 mm2 at the project's settings), so the walker
      // planted passes on crumbs that could never clear the progress floor: at the canonical
      // settings 29 of BootL's 265 cuts were under 1 mm long and 70 more under 3 mm, each one a
      // connection, a wall ride and a loopback. The floor is now minPassBite itself -- the one
      // number that already says what a pass must remove to have progressed -- so the walker
      // and the progress contract agree. Stock below it is the wall rides' and the residual's,
      // exactly as it was when such a pass was dropped a step later.
      advanced = walker.moveForwardToCutThreshold(cleared, moveDistance, minPassBite, maxBite)
      if (advanced) boundarySpan = walker.spanFrom(spanStart)
      // WO-410 exhaustion: a full boundary lap with no pass progressing means every
      // remaining in-band bite is a crumb the stepper cannot start on. Stop offering
      // them; fall through to reseed (roll-in / interior entry / honest termination).
      if (advanced && !passProgressed
        && walker.getOdometer() - lastProgressOdometer > walker.totalBoundaryLength() + moveDistance) {
        advanced = false
        walkerGaveUp = 'fruitless-lap' // WO-439 census: bites existed, none started a pass
      }
      if (advanced) bitesSinceProgress++ // WO-439 census: in-band bites handed out
    }
    if (passProgressed) { lastProgressOdometer = walker.getOdometer(); bitesSinceProgress = 0 }

    if (advanced) {
      const cur = walker.getCurrentPoint()
      toolPos = cur.pt
      toolDir = cur.dir
      pendingBoundarySpan = boundarySpan
    } else {
      // Engage frontier exhausted -> re-seed a fresh entry in the largest leftover pocket.
      const rs = reseed()
      // WO-439 census: what the walker tried before giving up, and what reseed then did.
      if (fragCensus.enabled) {
        fragCensus.reseeds.push({
          pass: pas,
          cause: walkerGaveUp,
          odometerSinceProgress: walker.getOdometer() - lastProgressOdometer,
          boundaryLength: walker.totalBoundaryLength(),
          bitesSinceProgress,
          outcome: rs ? rs.mode : 'stop',
          stop: rs ? undefined : (reseedStop ?? undefined),
          x: rs?.pt.x,
          y: rs?.pt.y,
          remainingArea: Math.abs(netArea(difference(cutRegion, cleared))),
        })
      }
      if (!rs) break
      // WO-1178: an entry that never emitted has no credit to keep. Hoisted out of the two
      // branches below (each did exactly this first) so the belief is honest BEFORE the
      // WO-1901 flush reads it -- a phantom seed disk would otherwise let a ring believe
      // ground was open that the machine never opened.
      if (pendingSeed && pendingEntry) cleared = pendingSeed.before
      pendingSeed = null
      // WO-1901: the tool is about to leave this region. Ride its wall ring now, at depth,
      // instead of lifting out and spiralling back down into its standing corner later.
      flushFinishedRegionCleanup(rs.pt)
      firstEngagePoint = true
      walker.initialize()
      lastProgressOdometer = 0 // WO-410: fresh region, fresh lap accounting
      bitesSinceProgress = 0 // WO-439 census only
      if (rs.mode === 'side') {
        pendingEntry = {
          point: rs.pt,
          clearPoint: rs.clearPoint,
          radius: 0,
          mode: 'side',
        }
        toolPos = rs.pt
        toolDir = rs.dir
        // WO-443: same walker responsibility on the reseed reconstruction as on the first
        // build above -- a fresh frontier does not re-acquire the credited finish band.
        walker = createEngagementWalker(rs.frontier, tool, forwardTravel, walkerRegion)
      } else {
        pendingSeed = { disk: rs.seedDisk, before: cleared }
        cleared = union(cleared, rs.seedDisk)
        pendingEntry = makeEntry(rs) // helix/plunge entry for this fresh region
        const opening = seedStart(rs.pt, rs.seedRadius, cleared)
        toolPos = opening.pos
        toolDir = opening.dir
      }
    }
  }
  // WO-1178: an interior entry still pending when the walk ends never emitted -- its disk was
  // never opened, so the belief is handed back before the residual and the rims are measured.
  if (pendingSeed && pendingEntry) { cleared = pendingSeed.before; pendingSeed = null }

  // Finishing contour pass along every machinable-region boundary loop (outer walls
  // AND island walls). The engagement-limited fill stops its outermost ring short of
  // the wall, leaving a thin uniform rim; riding the boundary clears it. The tool
  // centred on the cutRegion boundary reaches exactly to the target wall. FreeCAD's
  // FinishingProfile. (Role stays 'cut' for now; feedrate-by-role is Phase 5.)
  //
  // SKIPPED when wallCleanupAsWeGo cleans every transition in the requested material-side
  // direction. If a tangent cusp ride would invert that side, the ride is rejected and this
  // correctly oriented full-perimeter contour restores complete wall cleanup.
  //
  // WO-1901: this body used to BE the trailing loop, so on a multi-region cutRegion (two
  // chambers either side of a divider) every region's ring waited until the whole walk was
  // over. The tool then had to lift out of the last region and come back down into one it
  // had left -- and `reseamClosedTravel` seamed the ring at the vertex nearest that far-away
  // tool, which is the CORNER facing the region it came from, the one place the clearing
  // passes could not reach. The 2D planner believed that landing clear, so no rung here ever
  // fired; the 3D emitter's live carved field disagreed and dropped its WO-400 fallback
  // helix beside the standing corner (6 of them on the rest-pencil part). It is a FUNCTION
  // now (hoisted, so the walk can call it) and `flushFinishedRegionCleanup` calls it the
  // moment the walk leaves a finished region -- tool still at depth, seam next to the tool,
  // link planned through the floor that region just cleared. The trailing driver below is
  // unchanged for every loop the walk did not flush, so a single-region cutRegion -- the
  // common case -- runs exactly the sequence it always did.
  function emitCleanupContour(loop: Loop, loopIndex: number, early = false): boolean {
    if (cleanupContourDone.has(loopIndex)) return true
    const settle = (): boolean => { cleanupContourDone.add(loopIndex); return true }
    if (loop.length < 3) return settle()
    // A stock-outline roughing component has an artificial/open outer edge:
    // there is no retained wall to finish there. Following that contour also
    // creates corner re-entry landings where no interior helix can physically
    // fit. The caller may suppress only those positive-area loops; CW island
    // loops (the actual retained part walls) remain mandatory.
    if (params.skipOuterBoundaryCleanup && loopArea(loop) > 0) return settle()
    const contour = orientClosedTravel(
      (params.boundedPathCleanup ? boundedCleanPath : cleanPath)(closePath(loop), tolerance * AP.sampling.pathCleanTolerances),
      forwardTravel,
    )
    // A finishing contour that removes nothing is not emitted (2026-08-20, Operator's
    // dome). Since 5a4c1dd5 the full-clear envelope is 2R past the stock so a
    // fully-clear cutter can start outside it; an OPEN level's outer contour then
    // rides one tool radius outside the stock edge, cutter grazing air - the
    // dome's top level ran 3.5 mm wider than every level below (the holed levels
    // were already skipped by skipOuterBoundaryCleanup). Measured, not assumed:
    // the ride's corridor, clipped to the feature's real material, must remove
    // more than a tolerance-thin skin over a 2 mm window, else the wall it would
    // finish is already finished or never existed. A contour that does remove
    // material (a pocket wall, a stock edge the passes left) is unchanged.
    const rideCorridor = intersection(offsetOpenRound(contour, toolRadius, arcTol), featLoops)
    if (totalArea(difference(rideCorridor, cleared)) <= tolerance * AP.caps.emptyRideAreaTolerances) return settle()
    // WO-410 STALLED WALL RIM, contour side of the decision: a rim the roughing could not
    // take (too thick for the tangent skim, no roll-in reached it) is EXPLICITLY LEFT to
    // this contour -- but the contour is geometry-only, and riding it through a standing
    // rim is how a 10 mm ring with a 9.52 mm cutter shipped a 96%-of-slot lap (WO-409's
    // X-pocket lobe tips were this same ride). Measure the ride against the physical
    // cleared state with the ENGAGEMENT GATE'S own contract (75% of a slot over a 2 mm
    // window; over-cap length allowed up to the gate's 2 mm transient). Above that the
    // region REFUSES this rim: no ride, band not folded (residual honest), stats.aborted
    // set -- a loud partial region (WO-097), never a quiet slot. This is NOT the
    // withdrawn 08-20 span-drop guard: nothing is silently dropped -- under-cap rims are
    // still ridden whole, over-cap rims fail the region loudly (Operator's ruling A on
    // WO-409: keep refusing).
    const overload = contourOverCap(contour, cleared, toolRadius, AP.caps.slotCeilingDiameters * (2 * toolRadius), arcTol)
    if (overload.overLen > AP.caps.rideOverLenMaxMm) {
      // WO-1901: an EARLY ride is an optimisation, never a new way to fail. Hand the loop
      // back to the trailing driver unmarked and say nothing: by then `cleared` can only
      // have grown, so the verdict there is the one this region always got.
      if (early) return false
      console.warn(`[wall-rim] finishing contour REFUSED: ${overload.overLen.toFixed(1)} mm of the ride sustains > 75% of a slot (peak ${(overload.peak / (2 * toolRadius) * 100).toFixed(0)}% near (${overload.at.x.toFixed(2)}, ${overload.at.y.toFixed(2)})) against standing stock -- rim left unfinished, region reported partial (WO-410)`)
      operatorNotice('part of the wall finishing contour was left unfinished because riding it would overload the tool.')
      if (!aborted) aborted = 'wall-rim-overload'
      return settle()
    }
    // Finishing contour: `cleared` has NOT yet folded this contour's band (that happens
    // below), so it IS the physically-correct before-the-move state for the B8 gate here.
    // A very small or awkward component can fail the ordinary pass-retention
    // threshold yet still have a valid cleanup contour. That contour is then
    // the FIRST emitted motion and must consume the region's pending safe entry;
    // otherwise the pass block begins with an orphaned cut and cannot be safely
    // reordered or emitted by the 3D strategy.
    const cleanupEntry = passes.length === 0 ? pendingEntry : null
    // WO-453: RE-SEAM BEFORE THE CONNECTION IS PLANNED, AFTER EVERY GATE HAS SPOKEN.
    // Placed here on purpose: the ride-corridor emptiness test and the WO-410 over-cap
    // refusal above both ran on `contour` as clipper seamed it, so their verdicts are
    // bit-for-bit what they were -- this loop's GATING and FOLD semantics (the Untouchable
    // list) are untouched, and the fold below is built from `loop`, not from the ride.
    // The source is the SAME point appendCutPass will plan the connection from: the last
    // CUT pass's end (no prevMotion is passed here, exactly as WO-451's gap-fill ordering
    // reads it), or the region's own pending entry when this contour is the first motion.
    // Re-seaming to any other point would shorten a flight the planner does not make.
    const priorCut = lastCut(passes)
    const seamSource = priorCut ? priorCut.points[priorCut.points.length - 1] : (cleanupEntry ? cleanupEntry.point : null)
    const seamedContour = reseamClosedTravel(contour, seamSource)
    const enterContour = (seamed: Pt[]): UnsafeReentryError | null => {
      try {
        cleared = appendCutPass(passes, seamed, cleared, cleared, cutTree, cutRegion, toolRadius, helixRadius, stepOverDistance, arcTol, optimal, cleanupEntry, null, !!params.integralWallFollow, integralWallFollowLengthFactor, false, params.loopbackFilletPct ?? 25, millingDirection, landingUncutCap, undefined, !!params.liftFallbackHelix, 'cut', null, 0, exteriorAirAt, singleWallPass ? wallBandContour : null, true, params.repositionTime ?? null, onAcceptedGraphRoute)
        return null
      } catch (err) {
        if (!(err instanceof UnsafeReentryError)) throw err
        return err
      }
    }
    let refused = enterContour(seamedContour)
    // WO-1178 (attempt 3): A CLOSED LAP MAY SEAM AT ANY VERTEX. The nearest-vertex seam above
    // is the shortest flight, but its landing is one point; when that point is the standing
    // stock the lap exists to remove (the Triangle's acute apex: the ring sequence stops a
    // fraction of a millimetre short of it, the seam lands on a 28%-uncut disk, and the gate's
    // forward re-seam -- eight samples, each needing a lead that covers the skipped prefix --
    // finds nothing), the whole region used to be reported partial with its rim standing.
    // Rotating the seam is free (reseamClosedTravel: same vertices, same order, same sense,
    // same material) so before conceding, seam at the nearest vertex whose landing disk is
    // clear to the gate's own cap and plan the connection there -- the SAME ladder and the
    // SAME gate, only a longer flight. Not when the lap is the region's first motion (its
    // entry is pushed before the connection is planned, and a retry would push it twice).
    if (refused && seamSource && !cleanupEntry) {
      const first = contour[0], last = contour[contour.length - 1]
      const closed = contour.length >= 4 && Math.hypot(last.x - first.x, last.y - first.y) <= 1e-9
      const ring = closed ? contour.slice(0, -1) : []
      const seams = ring
        .map((v, index) => ({ v, index, d2: (v.x - seamSource.x) ** 2 + (v.y - seamSource.y) ** 2 }))
        .sort((a, b) => a.d2 - b.d2 || a.index - b.index)
        .filter(({ v }) => landingDiskUncutFraction(v, cleared, toolRadius, arcTol) <= landingUncutCap)
        .slice(0, 8)
      for (const { v, index } of seams) {
        const rotated = [...ring.slice(index), ...ring.slice(0, index), { x: v.x, y: v.y }]
        const again = enterContour(rotated)
        if (!again) {
          console.warn(`[lift-landing] cleanup contour re-seamed: the nearest seam refused (${refused.message}); the lap now starts at its vertex (${v.x.toFixed(2)}, ${v.y.toFixed(2)}), ${Math.sqrt((v.x - seamSource.x) ** 2 + (v.y - seamSource.y) ** 2).toFixed(2)}mm from the tool, whose landing disk is clear (WO-1178)`)
          refused = null
          break
        }
        refused = again
      }
    }
    if (refused) {
      // This wall contour cannot be reached safely: leave its rim standing and report it
      // (WO-400). Its band is deliberately NOT folded into `cleared`, so the residual is honest.
      // WO-1901: same rule as the over-cap rim above -- an early ride that cannot be reached
      // yet is handed back to the trailing driver, silently, and fails nothing.
      if (early) return false
      console.warn(`[lift-landing] cleanup contour skipped: ${refused.message}`)
      operatorNotice('a wall cleanup contour was skipped because there was no safe way to reach it.')
      if (!aborted) aborted = 'unsafe-re-entry'
      return settle()
    }
    if (cleanupEntry) { entries.push(cleanupEntry); pendingEntry = null }
    // Fold the swept band (points within toolRadius of the boundary) into cleared so
    // the residual measure reflects it. Band = dilate(loop,r) - erode(loop,r).
    const ccw = ensureCCW(loop)
    const band = difference(offsetClosed([ccw], toolRadius, arcTol), offsetClosed([ccw], -toolRadius, arcTol))
    cleared = union(cleared, band)
    return settle()
  }
  if (!params.wallCleanupAsWeGo || wallCleanupDirectionFallback.rejected) {
    for (let li = 0; li < cutRegion.length; li++) emitCleanupContour(cutRegion[li], li)
  }

  // Dedicated wall-finishing contour (wallFinish feature, default OFF). The FINISH contour =
  // the COMBINED featLoops offset inward by one tool radius PLUS the radial stock the
  // operation asked to leave (WO-450: toolRadius + wallFinishNearDepth, vs roughing's
  // toolRadius + finishStock), so the lap stops stockToLeave off the wall and takes only the
  // tolerance / 2 skin the rougher left above it. Under wallFinishToNet the offset is ONE
  // tool radius alone -- 0 radial stock, the pre-WO-450 shape, "stock to leave" read as
  // roughing-only. Offsetting the COMBINED loops (outer
  // boundary CCW + islands CW together) means that where an island sits closer than the
  // tool can fit, the resulting contour automatically WRAPS from the exterior wall around
  // the island as ONE path -- the Q5 blend, with no special-casing. Each resulting loop is
  // appended as a 'finish' pass AFTER all roughing/cleanup passes. The offset winding
  // remains canonical for geometry decisions; only the emitted travel order is oriented.
  if (params.wallFinish) {
    // WO-443/WO-445: the SAME contours the credited band was computed from, hoisted above
    // the pass loop. One contour per step, one band, no drift.
    const wallContour = wallFinishContour
    if (wallContour.length === 0) {
      // ADR-0003 fail-loud: requested a wall finish but the wall-finish offset is empty
      // (pocket narrower than one tool diameter everywhere) -- surface, don't silently drop.
      throw new Error(`[wallFinish] finish contour (offsetClosed by -(toolRadius + ${wallFinishNearDepth}) = -${toolRadius + wallFinishNearDepth}) returned empty/degenerate (ADR-0003)`)
    }
    // Keep the canonical combined region separate from travel-oriented finish passes.
    // Its complete outer-plus-islands topology is the fit contract for every lead arc --
    // for the roughing-offset wall rides too, which ride strictly INSIDE it and so are held
    // to the same no-crossing-a-neighbouring-wall contract with room to spare. WO-450 moved
    // this region INWARD by stockToLeave, so that room is now the tolerance / 2 skin rather
    // than the whole finishStock; the roughing rides still lie strictly inside it (their
    // offset is toolRadius + finishStock, deeper by exactly that skin), so the contract is
    // the same one, held on a smaller margin.
    finishFitRegion = wallContour

    // ---- WO-447 GAP-FILL: COMPLETE THE WALL-FOLLOW COVERAGE, DEEPEST STOCK FIRST ----
    //
    // Operator chose option A on the coverage-gap fork (answers.json 2026-08-20T22:19Z): the
    // wall-follow rides the WHOLE wall at its roughing offset. Stretches that no pass
    // transition happened to reach get ridden too, HERE, as part of roughing and before the
    // wall-finish pass below -- so the rougher provably leaves only the finishStock skin
    // everywhere the tool fits. Since WO-450 the single wall lap takes just the OUTER part
    // of that skin -- `finishStock - wallFinishNearDepth`, which by default is tolerance / 2
    // and under wallFinishToNet is the whole finishStock, as it was. The inner
    // wallFinishNearDepth is the radial stock the operator asked to keep and NO pass takes
    // it. This
    // REPLACES WO-445's semi lap, which was a SECOND full perimeter at this same offset and
    // which he rejected: only the MISSED fraction is ridden now, never the whole wall twice.
    //
    // WO-446 measured what these gaps are, and its measurement is why this is a coverage
    // problem and not a parameter one: with wallCleanupAsWeGo ON the full cleanup contour is
    // SKIPPED, so the wall is cleaned only where a transition happened to ride it, and what
    // stands is stepover-INVARIANT (0.55-0.60 mm above the skin at stepover 0.2 / 0.3 / 0.4).
    //
    // NOT RUN when the full cleanup-contour loop above ran (wallCleanupAsWeGo off, or its
    // direction fallback rejected). That loop walks the ENTIRE cutRegion boundary in the
    // requested direction: it IS complete coverage on its branch, and a "gap" ride there
    // would be a second ride over stock already taken -- recutting, a quality defect
    // (GOOD-SPEC section 1). That loop and its fold are untouchable.
    const cleanupContourRodeTheWholeBoundary = !params.wallCleanupAsWeGo || wallCleanupDirectionFallback.rejected
    if (!cleanupContourRodeTheWholeBoundary && wallBandContour.length > 0) {
      const wallTol = Math.max(arcTol * AP.sampling.wallTolArcTols, toolRadius * AP.sampling.wallTolToolRadii)
      // NAMED EPSILON. Below this a "gap" is not a stretch of standing wall, it is the
      // polygon's own faceting: the belief errs by ~arcTol at a corridor edge by
      // construction (GOOD-SPEC section 4), and refusing to chase that artifact is the same
      // discipline section 4 binds every other consumer to. tolerance is the user-facing
      // floor; 2 x arcTol is the geometric one; the larger governs.
      const GAP_EPS = Math.max(tolerance, 2 * arcTol)
      const arcTables = cutRegion.map(buildLoopArcTable)
      // COVERAGE, MEASURED OFF THE EMITTED STREAM. Every wall-follow ride in `passes` is a
      // sub-polyline of ONE cutRegion loop by construction (wallCleanLoop.ts's contract and
      // boundaryArcsBetween's), so projecting it back onto the loop recovers exactly the
      // span it rode. Reading the STREAM rather than threading a recorder through every
      // emission site means no site can be forgotten: merged rides, trimmed loopback rides,
      // cusp rides kept across a lift and tier-0 cut-through rides are all counted, because
      // all of them are in `passes` with role 'wallfollow'.
      const covered: [number, number][][] = cutRegion.map(() => [])
      for (const pass of passes) {
        if (pass.type !== 'wallfollow' && !(singleWallPass && pass.type === 'cut')) continue
        const pts = pass.points
        if (pts.length < 2) continue
        // A 3D wall-reaching cut can continue along the wall before it ends.
        // That motion already removed its wall band; assigning it again to a
        // gap pass sends the cutter backward over the just-cut tail.
        const proofTol = pass.type === 'cut' ? Math.min(wallTol, tolerance * AP.sampling.pathCleanTolerances + arcTol) : wallTol
        if (singleWallPass && pass.type === 'wallfollow') cleared = expandCleared(cleared, pts, toolRadius, arcTol)
        creditWallRide(covered, pts, cutRegion, arcTables, proofTol, arcTol)
      }
      // Only loops the credited band was computed from are offered gap-fill: the credit and
      // the ride come from the SAME geometry (wallBandContour), so they can never drift, and
      // skipOuterBoundaryCleanup withdraws both together.
      const fillable = new Set<number>()
      for (const loop of wallBandContour) {
        const li = cutRegion.indexOf(loop)
        if (li >= 0) fillable.add(li)
      }
      // WO-451: emission order is a motion decision, not a polygon-order accident. Collect
      // every fixed-sense ride first so gaps across ALL loops compete on distance from the
      // tool's live position. Material guards remain immediately before emission below, where
      // they see the same live, per-ride `cleared` state as before WO-451. Ties are stable and
      // explicit: loop index, then the span's canonical arc coordinate.
      const gapCandidates: {
        li: number
        gap: { start: number; len: number }
        ride: Pt[]
        guardQualified: boolean
      }[] = []
      for (let li = 0; li < cutRegion.length; li++) {
        if (!fillable.has(li)) continue
        const lp = cutRegion[li]
        if (lp.length < 3) continue
        const table = arcTables[li]
        if (table.per <= 0) continue
        wallCoverStats.boundaryLen += table.per
        wallCoverStats.coveredLen += Math.min(mergedSpanLength(covered[li]), table.per)
        for (const gap of uncoveredSpans(covered[li], table.per)) {
          wallCoverStats.gaps++
          if (gap.len <= GAP_EPS) { wallCoverStats.skippedShort++; continue }
          // ONE MILLING DIRECTION, ABSOLUTELY (GOOD-SPEC section 2, AC-SPEC R3). The span is
          // walked in the loop's canonical winding and then oriented by forwardTravel -- the
          // SAME convention the cleanup contour and the wall-finish pass use. It is then
          // VERIFIED against its own loop with the engine's existing predicate. A ride that
          // would present the wrong material side is REFUSED, never reversed: a reversed
          // ride is an opposite-sense CUT, which nothing in the tier ladder may smuggle in.
          const canonical = spanPolyline(lp, table, gap.start, gap.len)
          const ride = orientClosedTravel(canonical, forwardTravel)
          if (ride.length < 2) { wallCoverStats.skippedShort++; continue }
          if (!wallPointsMatchDirection(ride, [lp], millingDirection)) {
            console.warn(`[wall-coverage] gap ride REFUSED (direction): ${gap.len.toFixed(2)}mm span from (${ride[0].x.toFixed(2)}, ${ride[0].y.toFixed(2)}) on loop ${li} would present the wrong material side for ${millingDirection} -- NOT reversed (that would be an opposite-sense cut), material left standing`)
            operatorNotice('a stretch of wall was left uncut because cutting it would reverse the milling direction.')
            wallCoverStats.refusedDirection++
            if (!aborted) aborted = 'wall-coverage-direction'
            continue
          }
          gapCandidates.push({ li, gap, ride, guardQualified: false })
        }
      }
      // Keep references in historical loop/arc order for the measurement-only counter. The
      // nearest-first loop splices its own array while marking the candidates that pass both
      // live-state material guards, matching the counter's pre-WO-451 qualification boundary.
      const historicalGapCandidates = gapCandidates.slice()
      // The first approach starts where appendCutPass historically starts it: the last CUT.
      // After an accepted gap ride the tool physically sits at that ride's end; pass the full
      // ride forward as WO-447 requires because a 'wallfollow' pass is invisible to lastCut.
      const gapSource = lastCut(passes)
      let toolPosition = gapSource?.points[gapSource.points.length - 1] ?? null

      // ---- WO-460/WO-1215: NEAREST-FIRST MUST NEVER LOSE TO THE ORDER IT REPLACED ----
      //
      // Nearest-neighbour is a GREEDY heuristic, and greedy is not always shorter. WO-451's
      // own evidence table caught it losing once out of six: SquareIsland CONVENTIONAL went
      // 202.344 -> 267.355 mm of between-ride travel (+32.1%) because taking the closest ride
      // each time stranded a far one and paid for it at the end. Conventional is not the
      // direction the GOOD-Corpus resolves to, but params.millingDirection is the operator's
      // checkbox, so a real user on a real island part flies that 32%.
      //
      // THE FIX IS A COMPARISON, NOT A NEW HEURISTIC. Every candidate ride's start and end
      // point is already fixed here -- the set was qualified above against the SAME pre-gap
      // physical state, and WO-451's invariant is that ordering cannot change WHICH spans are
      // in it. So both candidate orders can be SCORED before a single pass is emitted, and
      // the shorter one emitted. A tie goes to nearest-first: it is the better default and it
      // keeps WO-451's four wins bit-stable.
      //
      // Scored on BETWEEN-RIDE travel only, which is what the two counters above report and
      // what the Done-when numbers are quoted in. The lead-in hop from the last cut into the
      // FIRST ride is deliberately excluded from both scores: nearest-first picks its opener
      // to minimise exactly that hop, so charging it would score the two orders on different
      // questions.
      //
      // The score is a PREDICTION over the whole candidate set; the emission loop below still
      // re-picks against the LIVE tool position, because a candidate the material guards skip
      // never moves the tool. Nothing about the nearest-first branch changes -- when
      // nearest-first wins, this block only reads.
      //
      // AND THE PROXY IS NOT THE COST -- MEASURED, NOT ASSUMED. Operator widened this WO on
      // 2026-08-22 ("look at the reordering to optimize away retracts when possible") and told
      // the lane to score both orders on travel AND retracts, report both, and file a card if
      // they genuinely trade off. Retracts cannot be predicted here -- a retract is the tier
      // ladder's verdict and the ladder only speaks while appending -- so both orders were
      // EMITTED and measured across the nine-fixture corpus in both directions
      // (src/tests/evidence/WO-460/). The straight-line hop score above disagrees with the
      // shorter order on exactly one case out of eighteen, SquareIsland conventional, and on
      // that case the order it prefers is not a trade-off, it is strictly worse:
      //
      //   between-ride hops   267.355 -> 202.344 mm   (what the proxy sees:      -24.3%)
      //   FLOWN gap travel    354.639 -> 408.374 mm   (what the machine flies:   +15.2%)
      //   wall ride length    636.42  -> 751.85  mm   (+115 mm, one hop routed as a skim)
      //   worst off-wall step   3.508 ->  71.958 mm   inside a 'wallfollow' pass
      //   wall-finish laps    1 retract + 1 stop-short keep-down -> 2 RETRACTS + 0
      //
      // A short straight line is not a short connection: a near hop across standing stock is
      // routed along the wall or conceded to a lift, while a far hop over cleared ground flies
      // straight. So the proxy buys 65 mm it can see and pays 115 mm and an extra tier-3
      // retract it cannot -- against Operator's widening AND against this WO's own "lifts
      // unchanged" bar. The engine therefore RECORDS the disagreement (gapOrderShorterPlan vs
      // gapOrderChoice) and emits the order the measurement supports.
      //
      // WO-1215: WO-1211's interpolated cross-sections exposed the missing discriminator.
      // Historical has the shorter straight-hop score on all three conventional gap fixtures,
      // but it is better machine motion only on Bar. The separating fact is the FIRST finish
      // connection: Bar's historical order ends within the existing fed stop-short limit while
      // nearest-first must cross standing stock and retract; SquareIsland gains no retract and
      // BootL is the inverse. Predict that rung with its exact corridor/gouge/load predicates,
      // advancing a private cleared belief through only the rides the live material guards would
      // accept. This is still one emission: it prices two small candidate lists geometrically,
      // never runs appendCutPass twice.
      const rideEndOf = (candidate: { ride: Pt[] }): Pt => candidate.ride[candidate.ride.length - 1]
      const betweenRideTravel = (sequence: typeof gapCandidates): number => {
        let travel = 0
        for (let i = 1; i < sequence.length; i++) {
          const previous = rideEndOf(sequence[i - 1])
          const current = sequence[i].ride[0]
          travel += Math.hypot(current.x - previous.x, current.y - previous.y)
        }
        return travel
      }
      // The SAME greedy the emission loop runs, with the SAME stable tie-break (loop index,
      // then the span's canonical arc coordinate), over the full candidate set.
      const nearestFirstPlan = (from: Pt | null, pool: typeof gapCandidates): typeof gapCandidates => {
        const remaining = pool.slice()
        const sequence: typeof gapCandidates = []
        let at = from
        while (remaining.length > 0) {
          let nearest = 0
          let nearestDistance = at ? Math.hypot(remaining[0].ride[0].x - at.x, remaining[0].ride[0].y - at.y) : 0
          for (let i = 1; i < remaining.length; i++) {
            const candidate = remaining[i]
            const distance = at ? Math.hypot(candidate.ride[0].x - at.x, candidate.ride[0].y - at.y) : 0
            const best = remaining[nearest]
            if (distance < nearestDistance
              || (distance === nearestDistance && (candidate.li < best.li
                || (candidate.li === best.li && candidate.gap.start < best.gap.start)))) {
              nearest = i
              nearestDistance = distance
            }
          }
          const picked = remaining.splice(nearest, 1)[0]
          at = rideEndOf(picked)
          sequence.push(picked)
        }
        return sequence
      }
      const canKeepDownToFirstFinish = (sequence: typeof gapCandidates, from: Pt | null): boolean => {
        let at = from
        let plannedCleared = cleared
        for (const candidate of sequence) {
          const rideCorridor = intersection(offsetOpenRound(candidate.ride, toolRadius, arcTol), featLoops)
          if (totalArea(difference(rideCorridor, plannedCleared)) <= tolerance * AP.caps.emptyRideAreaTolerances) continue
          const overload = contourOverCap(candidate.ride, plannedCleared, toolRadius, AP.caps.slotCeilingDiameters * (2 * toolRadius), arcTol)
          if (overload.overLen > AP.caps.rideOverLenMaxMm) continue
          plannedCleared = expandCleared(plannedCleared, candidate.ride, toolRadius, arcTol)
          at = rideEndOf(candidate)
        }
        const firstFinishLoop = wallContour[0]
        if (!at || !firstFinishLoop || firstFinishLoop.length < 3) return false
        const oriented = orientClosedTravel((params.boundedPathCleanup ? boundedCleanPath : cleanPath)(closePath(firstFinishLoop), tolerance * AP.sampling.pathCleanTolerances), forwardTravel)
        const target = reseamClosedTravel(oriented, at)[0]
        const wallTree = offsetClosedTree(featLoops, -toolRadius, arcTol)
        const cheapTierCap = AP.caps.rideCapStepovers * stepOverDistance
        const stopShort = planStopShortKeepDown({
          source: at,
          target,
          arcTol,
          gouges: (a, b) => centrePathExitsCutRegion(a, b, wallTree, toolRadius),
          travelClear: (a, b) => {
            const corridor = intersection(offsetOpenRound([a, b], toolRadius, arcTol), featLoops)
            return totalArea(difference(corridor, plannedCleared)) > TRAVEL_BELIEF_UNCUT_EPS ? 'standing stock' : null
          },
          feedClear: (a, b) => rideOverloadsUncut([a, b], plannedCleared, toolRadius, cheapTierCap, arcTol)
            ? 'standing stock exceeds the finish feed cap'
            : null,
          feedLenCap: 2 * stepOverDistance,
        })
        return 'travel' in stopShort
      }
      if (gapCandidates.length > 1) {
        const nearestPlan = nearestFirstPlan(toolPosition, gapCandidates)
        wallCoverStats.gapOrderOrderedPlanLen = betweenRideTravel(historicalGapCandidates)
        wallCoverStats.gapOrderNearestPlanLen = betweenRideTravel(nearestPlan)
        // Strictly shorter hops win the PLAN; a tie keeps nearest-first. A SILENT fallback is
        // how a heuristic stops being auditable, so the plan winner is recorded whether or not
        // it is the order emitted -- that gap IS the finding, and the corpus stats say it.
        wallCoverStats.gapOrderShorterPlan = wallCoverStats.gapOrderOrderedPlanLen < wallCoverStats.gapOrderNearestPlanLen
          ? 'historical'
          : 'nearest-first'
        if (wallCoverStats.gapOrderShorterPlan === 'historical') {
          const historicalKeepsDown = canKeepDownToFirstFinish(historicalGapCandidates, toolPosition)
          const nearestKeepsDown = canKeepDownToFirstFinish(nearestPlan, toolPosition)
          wallCoverStats.gapOrderChoice = historicalKeepsDown && !nearestKeepsDown
            ? 'historical'
            : 'nearest-first'
        } else {
          wallCoverStats.gapOrderChoice = 'nearest-first'
        }
      }
      if (gapOrderOverride) wallCoverStats.gapOrderChoice = gapOrderOverride
      // `gapCandidates` is still in historical loop/arc order, so index 0 IS that order.
      const emitHistoricalOrder = wallCoverStats.gapOrderChoice === 'historical'

      let priorWallRide: Pt[] | null = null
      while (gapCandidates.length > 0) {
        let nearest = 0
        if (!emitHistoricalOrder) {
          let nearestDistance = toolPosition
            ? Math.hypot(gapCandidates[0].ride[0].x - toolPosition.x, gapCandidates[0].ride[0].y - toolPosition.y)
            : 0
          for (let i = 1; i < gapCandidates.length; i++) {
            const candidate = gapCandidates[i]
            const distance = toolPosition
              ? Math.hypot(candidate.ride[0].x - toolPosition.x, candidate.ride[0].y - toolPosition.y)
              : 0
            const best = gapCandidates[nearest]
            if (distance < nearestDistance
              || (distance === nearestDistance && (candidate.li < best.li
                || (candidate.li === best.li && candidate.gap.start < best.gap.start)))) {
              nearest = i
              nearestDistance = distance
            }
          }
        }
        const candidate = gapCandidates.splice(nearest, 1)[0]
        const { li, gap, ride } = candidate
        // NOTHING TO REMOVE, NOTHING TO RIDE. The same MEASURED guard the cleanup contour
        // above applies to a whole loop, applied per span against the live state left by every
        // previously accepted ride. A stretch whose material was already taken is not a
        // coverage gap -- riding it would be air-grazing travel, and on a stock outline it
        // manufactures corner re-entry landings.
        const rideCorridor = intersection(offsetOpenRound(ride, toolRadius, arcTol), featLoops)
        if (totalArea(difference(rideCorridor, cleared)) <= tolerance * AP.caps.emptyRideAreaTolerances) { wallCoverStats.skippedEmpty++; continue }
        // WO-410 STALLED WALL RIM, unchanged contract and live-state input: a rim too thick
        // for a contour ride is REFUSED loudly rather than ridden as a near-slot.
        const overload = contourOverCap(ride, cleared, toolRadius, AP.caps.slotCeilingDiameters * (2 * toolRadius), arcTol)
        if (overload.overLen > AP.caps.rideOverLenMaxMm) {
          console.warn(`[wall-coverage] gap ride REFUSED: ${overload.overLen.toFixed(1)} mm of a ${gap.len.toFixed(1)} mm span sustains > 75% of a slot (peak ${(overload.peak / (2 * toolRadius) * 100).toFixed(0)}% near (${overload.at.x.toFixed(2)}, ${overload.at.y.toFixed(2)})) against standing stock -- span left unfinished, region reported partial (WO-410)`)
          operatorNotice('a stretch of wall was left uncut because riding it would overload the tool.')
          wallCoverStats.refusedOverload++
          if (!aborted) aborted = 'wall-rim-overload'
          continue
        }
        candidate.guardQualified = true
        // APPROACH AND LANDING VIA THE EXISTING GATED MACHINERY ONLY -- the identical call
        // the cleanup-contour loop above makes. No new gate math, no exemptions: the
        // keep-down/lift decision, the tier ladder, the keep-down overload cap, the
        // lift-landing gate and T5's corridor proof all run exactly as they do for any
        // other pass. `cleared, cleared` is the physically-correct pre-move state (this
        // span's own band is folded only AFTER the ride is accepted, below).
        const gapEntry = passes.length === 0 ? pendingEntry : null
        // WO-453, the third closed-loop ride site. A gap span that covers a WHOLE loop (no
        // transition ride touched it, so uncoveredSpans returns one span of the full period)
        // comes back from spanPolyline CLOSED, and its seam is then arc coordinate 0 = loop[0]
        // -- the same arbitrary vertex the cleanup contour had. Re-seam it to where the tool
        // stands, which for this loop is `toolPosition` (the prior ride's end, or the last cut
        // before any ride) -- the same point appendCutPass plans the connection from via
        // `priorWallRide`. Placed AFTER both material guards so their verdicts and WO-451's
        // nearest-first ordering read exactly the rides they read before. An OPEN span (every
        // occurrence on the nine-fixture corpus, both directions, wallFinish on and off) is
        // returned untouched: rotating one would drop the head of the only ride that takes it.
        const seamedRide = reseamClosedTravel(ride, toolPosition)
        let afterRide: Loops
        try {
          afterRide = appendCutPass(passes, seamedRide, cleared, cleared, cutTree, cutRegion, toolRadius, helixRadius, stepOverDistance, arcTol, optimal, gapEntry, null, !!params.integralWallFollow, integralWallFollowLengthFactor, false, params.loopbackFilletPct ?? 25, millingDirection, landingUncutCap, undefined, !!params.liftFallbackHelix, 'wallfollow', priorWallRide, 0, exteriorAirAt, singleWallPass ? wallBandContour : null, false, params.repositionTime ?? null, onAcceptedGraphRoute)
        } catch (err) {
          if (!(err instanceof UnsafeReentryError)) throw err
          // REFUSED GAPS STAY LOUD (WO-447 method 4): this span cannot be reached safely,
          // so its material stays standing. Its band is deliberately NOT folded, so it
          // surfaces in residualFinishBandArea and the residual stays honest.
          console.warn(`[wall-coverage] gap ride SKIPPED (no safe gated approach): ${gap.len.toFixed(2)}mm span from (${ride[0].x.toFixed(2)}, ${ride[0].y.toFixed(2)}) to (${ride[ride.length - 1].x.toFixed(2)}, ${ride[ride.length - 1].y.toFixed(2)}) on loop ${li} -- ${err.message}`)
          operatorNotice('a stretch of wall was left uncut because there was no safe way to reach it.')
          wallCoverStats.refusedApproach++
          if (!aborted) aborted = 'unsafe-re-entry'
          continue
        }
        if (gapEntry) { entries.push(gapEntry); pendingEntry = null }
        // FOLD: the span's swept capsule (the span dilated by toolRadius), the same band
        // construction the cleanup-contour fold uses, per span. The ride physically sweeps
        // it, so the belief must say so or the residual over-reports.
        cleared = expandCleared(afterRide, seamedRide, toolRadius, arcTol)
        if (priorWallRide) {
          const previous = priorWallRide[priorWallRide.length - 1]
          // WO-453: measured off the ride AS EMITTED, so the counter keeps meaning what it
          // meant -- the connection length the machine actually flies.
          wallCoverStats.filledGapConnectionLen += Math.hypot(seamedRide[0].x - previous.x, seamedRide[0].y - previous.y)
        }
        priorWallRide = seamedRide
        toolPosition = seamedRide[seamedRide.length - 1]
        wallCoverStats.filled++
        wallCoverStats.filledLen += gap.len
      }
      const historicallyOrderedQualified = historicalGapCandidates.filter(candidate => candidate.guardQualified)
      for (let i = 1; i < historicallyOrderedQualified.length; i++) {
        const previousRide = historicallyOrderedQualified[i - 1].ride
        const previous = previousRide[previousRide.length - 1]
        const current = historicallyOrderedQualified[i].ride[0]
        wallCoverStats.orderedGapConnectionLen += Math.hypot(current.x - previous.x, current.y - previous.y)
      }
    }

    // ---- WO-449: EVERY CONNECTION INTO A FINISH LAP DESCENDS THE LADDER ----
    //
    // Region context for the gate: the TRUE-WALL tool-centre region, not cutRegion. A finish
    // lap rides `finishStock - wallFinishNearDepth` CLOSER to the wall than the roughing
    // offset reaches, so its own start point sits outside cutRegion by construction --
    // gating its lead against cutRegion would reject every legal route and force a helix (or
    // a refusal) at every lap. WO-450 SPLIT wallTree FROM wallContour: wallTree stays at
    // -toolRadius while wallContour moved in to -(toolRadius + wallFinishNearDepth), so they
    // are no longer the same offset. wallTree is now a SUPERSET that CONTAINS wallContour,
    // and the containment is what the gate needs: the lap's start point lies on wallContour,
    // hence strictly inside wallTree with wallFinishNearDepth of margin instead of sitting on
    // its boundary. The gate region deliberately does NOT shrink with the operator's stock --
    // it is the true machinable wall, which is the fixed thing a lead may not cross.
    const wallTree = offsetClosedTree(featLoops, -toolRadius, arcTol)
    // THE PRE-MOVE BELIEF this connection is gated against (GOOD-SPEC section 4
    // clearedBeforePass discipline): all roughing folded -- that is `cleared` -- plus each
    // lap's own swept capsule folded HERE as the stack advances, because a lap physically
    // runs before the NEXT connection does. The RETURNED `cleared` is deliberately untouched:
    // WO-443's residual accounting folds no finish pass, and this local copy keeps that
    // promise, so every residual/stat number stays bit-for-bit what it was.
    let finishCleared: Loops = cleared
    const cheapTierCap = AP.caps.rideCapStepovers * stepOverDistance

    /** The connection into `contour` from where the tool physically is. Tier 3 with a gated
     *  descent, attributed -- including the measured verdict of the cheaper tiers' own
     *  corridor proof, so the follow-up that wants tier 0/1/2 here has data, not argument. */
    const planFinishApproach = (source: Pt, contour: Pt[]): FinishApproach | null => {
      const target = contour[0]
      // THE CHEAPER TIERS, TRIED FIRST AND BY THE SAME PROOF the engine holds tier 1's rungs
      // and WO-437's micro-lift to: the direct corridor at FULL tool width against the
      // physical pre-move state, plus the gouge veto. Never a loosened version.
      let cheap: string
      if (centrePathExitsCutRegion(source, target, wallTree, toolRadius)) {
        cheap = `tier0/1/2 REFUSED gouge@(${target.x.toFixed(2)}, ${target.y.toFixed(2)})`
      } else {
        const plow = rideOverloadsUncut([source, target], finishCleared, toolRadius, cheapTierCap, arcTol)
        if (plow) {
          cheap = `tier0/1/2 REFUSED plow@(${plow.at.x.toFixed(2)}, ${plow.at.y.toFixed(2)}) w=${plow.width.toFixed(2)}>cap=${cheapTierCap.toFixed(2)}`
        } else {
          // THE LOAD CAP IS NOT T5'S BAR. rideOverloadsUncut is a sustained-WIDTH proof at
          // 1.5 x stepover -- the right bar for a tier-0 cut-through, and the one WO-437's
          // micro-lift uses. Tiers 1 and 2 run at TRAVERSE speed, where GOOD-SPEC section 3
          // and T5 allow ZERO belief-uncut, so a load-clear corridor still has to be measured
          // against that stricter bar before it can be called takeable. A finish lap starts
          // against standing skin -- `finishStock - wallFinishNearDepth` of it, the whole
          // finishStock under wallFinishToNet and tolerance / 2 by default since WO-450 -- so
          // the tail of every such corridor is inside belief-uncut by construction. That is
          // why the number below is rarely zero. It is also why the tier the ladder settles
          // on MOVES with the stock setting rather than being fixed: a thinner standing skin
          // sweeps less belief-uncut, so a cheaper rung can clear WO-449's cap. Nothing here
          // is tuned to a tier; the ladder is re-proved per connection either way.
          const corridor = intersection(offsetOpenRound([source, target], toolRadius, arcTol), featLoops)
          const uncutSwept = totalArea(difference(corridor, finishCleared))
          cheap = `tier0/1/2 corridor load-CLEAR but sweeps ${uncutSwept.toFixed(2)}mm2 of belief-uncut -- T5 zero-tolerance REFUSES it at traverse speed`
        }
      }
      // WO-466 TIER 2.5 -- STAY DOWN, STOP SHORT OF THE SKIN, FEED THE LAST BIT. Offered
      // AFTER the cheap whole-corridor tiers have been MEASURED and BEFORE the tier-3 retract
      // is planned, which is exactly where GOOD-SPEC section 3 puts a rung dearer than a
      // plain keep-down and cheaper than a flight to clearance. The measurement above is what
      // makes it the right rung here rather than a guess: `cheap` records that the corridor is
      // load-CLEAR and that only its TAIL sweeps belief-uncut -- which is not a coincidence but
      // construction, since a finish lap starts against the standing skin. Split it there.
      // Region context, belief and caps are the ones the tiers either side already use:
      // wallTree (the TRUE machinable wall) for the gouge veto, finishCleared for the proof.
      const stopShort = planStopShortKeepDown({
        source,
        target,
        arcTol,
        gouges: (a, b) => centrePathExitsCutRegion(a, b, wallTree, toolRadius),
        // WO-449'S OWN TRAVEL BAR, VERBATIM -- the corridor swept inside the feature,
        // differenced against the pre-move belief, refused on ANY belief-uncut at all. That
        // is the zero-tolerance rule Operator accepted the WO-449 fix for. WO-466 does not touch
        // it; it only asks the same question about a PREFIX instead of the whole chord.
        travelClear: (a, b) => {
          const corridor = intersection(offsetOpenRound([a, b], toolRadius, arcTol), featLoops)
          const swept = totalArea(difference(corridor, finishCleared))
          return swept > TRAVEL_BELIEF_UNCUT_EPS
            ? `sweeps ${swept.toFixed(3)}mm2 of belief-uncut -- T5 zero-tolerance REFUSES it at traverse speed`
            : null
        },
        // The site's own CUTTING-load bar -- the one the `cheap` measurement above calls
        // "load-CLEAR", at the same cap, against the same belief.
        feedClear: (a, b) => {
          const plow = rideOverloadsUncut([a, b], finishCleared, toolRadius, cheapTierCap, arcTol)
          return plow
            ? `sustains ${plow.width.toFixed(2)}mm effective width > cap ${cheapTierCap.toFixed(2)}mm near (${plow.at.x.toFixed(2)}, ${plow.at.y.toFixed(2)})`
            : null
        },
        feedLenCap: 2 * stepOverDistance,
      })
      if ('travel' in stopShort) {
        // ADR-0003 fail-loud: the rung that recovered this connection names itself and its proof.
        console.warn(`[finish-connection] wall-finish lap at (${target.x.toFixed(2)}, ${target.y.toFixed(2)}) STAYS DOWN (WO-466): ${stopShort.reason}`)
        return {
          tier: 'stopshort',
          // NO DESCENT HAPPENS on this tier -- the tool never leaves the floor. The field is
          // kept at the lap's own start so every reader that reports "where the approach put
          // the tool" still reads the seam, and `helix`/`lead` stay absent by construction.
          descent: target,
          travel: stopShort.travel,
          feed: stopShort.feed,
          reason: `${cheap} -> tier2.5 stop-short keep-down, ${stopShort.reason}`,
        }
      }
      const gate: LandingGateContext = {
        passes,
        clearedBeforePass: finishCleared,
        cutRegion: wallContour,
        cutTree: wallTree,
        toolRadius,
        helixRadius,
        stepOverDistance,
        arcTol,
        landingUncutCap,
        millingDirection,
        points: contour,
        boundarySpan: null,
        // A CLOSED lap has no skippable head: re-seaming it forward would drop that stretch
        // of wall from the only pass that finishes it.
        allowReseam: false,
        onAcceptedGraphRoute,
      }
      let plan: ReturnType<typeof planGatedLanding>
      try {
        plan = planGatedLanding(gate, source, target, contour[1] ?? target)
      } catch (err) {
        if (!(err instanceof UnsafeReentryError)) throw err
        // ADR-0003 fail-loud: no gated way into this lap exists. The lap is DROPPED -- its
        // skin stays standing and surfaces in the residual -- rather than entered by a bare
        // feed, which is the defect this whole block exists to remove.
        console.warn(`[finish-connection] wall-finish lap at (${target.x.toFixed(2)}, ${target.y.toFixed(2)}) SKIPPED: ${cheap}, tier2.5 stop-short REFUSED: ${stopShort.refused}, and no gated descent exists -- ${err.message}`)
        operatorNotice('a wall-finish lap was skipped because there was no safe way to reach it.')
        return null
      }
      if (plan.keepDownApproach) {
        const approach = plan.keepDownApproach
        return {
          tier: 'stopshort',
          descent: target,
          ...(approach.departure ? { departure: approach.departure } : {}),
          travel: approach.travel,
          feed: approach.lead,
          reason: `${cheap} -> tier2.5 stop-short REFUSED: ${stopShort.refused} -> WO-1138 routed keep-down via ${approach.family}, ${polylineLength(approach.travel).toFixed(2)}mm clear traverse + ${polylineLength(approach.lead).toFixed(2)}mm fed engage`,
        }
      }
      const rung = plan.helix
        ? `helix@(${plan.helix.center.x.toFixed(2)}, ${plan.helix.center.y.toFixed(2)}) r=${plan.helix.radius.toFixed(2)}`
        : plan.lead
          ? `${plan.clearAirLanding ? 'clear-AIR landing' : 'proven-cleared shaft'}@(${plan.landing.x.toFixed(2)}, ${plan.landing.y.toFixed(2)}) + ${polylineLength(plan.lead).toFixed(2)}mm tangent lead`
          : 'descent on the lap start (disk clear within cap)'
      return {
        tier: 'retract',
        descent: plan.helix ? target : plan.landing,
        ...(plan.helix ? { helix: plan.helix } : {}),
        ...(plan.lead ? { lead: plan.lead } : {}),
        ...(plan.clearAirLanding ? { clearAirLanding: true as const } : {}),
        ...(plan.cutStartIndex ? { cutStartIndex: plan.cutStartIndex } : {}),
        reason: `${cheap} -> tier2.5 stop-short REFUSED: ${stopShort.refused} -> tier3 retract, ${rung}`,
      }
    }

    // THE TRUE-WALL LAP -- now the only finish pass, and it meets only the skin the
    // completed roughing coverage left it.
    for (const loop of wallContour) {
      // The single-pass contract put the whole legal wall band on the same
      // offset as the coverage pass above. There is no second skin to remove.
      if (singleWallPass) continue
      if (loop.length < 3) continue
      const orientedContour = orientClosedTravel(
        (params.boundedPathCleanup ? boundedCleanPath : cleanPath)(closePath(loop), tolerance * AP.sampling.pathCleanTolerances),
        forwardTravel,
      )
      if (orientedContour.length < 3) continue
      if (passes.length === 0 && pendingEntry) {
        passes.push({
          type: 'entry',
          point: pendingEntry.point,
          ...(pendingEntry.clearPoint ? { clearPoint: pendingEntry.clearPoint } : {}),
          radius: pendingEntry.radius,
          mode: pendingEntry.mode,
        })
        entries.push(pendingEntry)
        pendingEntry = null
        // The entry physically opens its own disk before anything else runs; the connection
        // out of it is gated against that state, exactly as a re-seed's is.
        finishCleared = union(finishCleared, diskPath(entries[entries.length - 1].point, entries[entries.length - 1].radius + toolRadius, arcTol))
      }
      const source = lastEmittedPoint(passes)
      // No prior motion at all means no connection to gate: emit owns the approach (there is
      // nothing before this lap to travel from). Every real feature has roughing before it.
      //
      // SEAM (WO-453, superseding WO-449's note here). WO-449 searched four seam candidates
      // per lap for a FRIENDLIER DESCENT (longest straight run on both sides, first non-helix
      // plan wins) and dropped the search because it bought nothing -- 6 helix descents
      // before, 6 after. That measurement stands and this is not a retry of it: the objective
      // here is TRAVEL, not the descent rung. The lap starts at the vertex nearest where the
      // tool physically stands, so the gated connection below judges the SHORT flight instead
      // of a flight to whatever vertex clipper happened to leave at loop[0]. Whichever rung
      // then answers, it answers over a shorter corridor. The lap itself is unchanged: same
      // vertices, same order, same travel sense, same skin removed (reseamClosedTravel).
      const contour = reseamClosedTravel(orientedContour, source)
      const approach = source ? planFinishApproach(source, contour) : null
      if (source && !approach) {
        if (!aborted) aborted = 'unsafe-re-entry'
        continue
      }
      const contourOut = contour
      passes.push({ type: 'finish', points: contourOut })
      finishClearedRegions.push(loopArea(loop) > 0 ? 'inside' : 'outside')
      finishPassOffsets.push('wall')
      finishApproaches.push(approach ?? undefined)
      // The lap (and its gated lead) physically removes its corridor: the NEXT connection is
      // gated against the state it actually meets.
      finishCleared = union(finishCleared, offsetOpenRound(contourOut, toolRadius, arcTol))
      if (approach?.lead && approach.lead.length >= 2) {
        finishCleared = union(finishCleared, offsetOpenRound(approach.lead, toolRadius, arcTol))
      }
      if (approach?.helix) {
        finishCleared = union(finishCleared, diskPath(approach.helix.center, approach.helix.radius + toolRadius, arcTol))
      }
      // WO-466 tier 2.5: the travel and the fed tail both run the cutter over ground at depth,
      // so the belief the NEXT connection is gated against must say so.
      if (approach?.travel && approach.travel.length >= 2) {
        finishCleared = union(finishCleared, offsetOpenRound(approach.travel, toolRadius, arcTol))
      }
      if (approach?.feed && approach.feed.length >= 2) {
        finishCleared = union(finishCleared, offsetOpenRound(approach.feed, toolRadius, arcTol))
      }
    }
  }

  // Honest residual: what material is actually left uncut inside the target region
  // (feature inset by the finish stock). This is the gap measure that % coverage hides.
  const residual = difference(targetRegion, cleared)
  const residualArea = Math.abs(netArea(residual)) // net: cleared pockets inside the residual subtract
  droppedSliverStats.regions = droppedSliverRegions.map(region => {
    // Report physical material, not the tiny tool-centre polygon: dilate the dropped
    // component by the cutter radius, then count only what remains in the final honest
    // residual after cleanup/finish providers have had their turn.
    const swept = offsetClosed(region.loops, toolRadius, arcTol)
    const sweptResidual = swept.length ? intersection(swept, residual) : []
    return {
      toolCentreArea: region.toolCentreArea,
      sweptArea: Math.abs(netArea(sweptResidual)),
      stage: region.stage,
      largestEntryRadius: region.largestEntryRadius,
    }
  })
  // The headline number stays what it always was: the largest entry that fits anywhere in
  // the material this run declined. Derived from the records so prevention and the buffer
  // cannot report it differently.
  droppedSliverStats.largestEntryRadius = droppedSliverStats.regions.length
    ? Math.max(...droppedSliverStats.regions.map(region => region.largestEntryRadius))
    : null
  // WO-443 step 3: SPLIT THE LEFTOVER THE SAME WAY THE RESPONSIBILITY WAS SPLIT, so
  // nothing hides. residualWalker is what the walk left standing in its own region;
  // residualFinishBand is what still stands inside the band the WALL RIDES are credited
  // with -- since WO-447 that band's machining-load layer is taken during roughing by the
  // completed wall-follow coverage (transition rides + gap fills), whose swept capsules ARE
  // folded into `cleared`, so a healthy band account reads ~0 and a REFUSED gap (never
  // folded, always warned) surfaces here as exactly the material it left standing. By
  // construction (finishBand is already clipped to targetRegion, and
  // walkerRegion is targetRegion minus finishBand) the two sum to the total residual to
  // clipper tolerance -- the identity is asserted in the evidence run, not in this hot
  // path. With wallFinish off finishBand is empty, residualWalker IS residual (same object,
  // so every number below is bit-for-bit what it was) and the band account reads zero.
  const residualWalker = finishBand.length ? difference(walkerRegion, cleared) : residual
  const residualFinishBand: Loops = finishBand.length ? difference(finishBand, cleared) : []
  const residualWalkerArea = finishBand.length ? Math.abs(netArea(residualWalker)) : residualArea
  const residualFinishBandArea = residualFinishBand.length ? Math.abs(netArea(residualFinishBand)) : 0
  // WO-410: measure up to 1.5 x toolRadius, not toolRadius. Capping the search AT the
  // tool radius made `residualMaxInscribedR > toolRadius` below mathematically
  // unreachable (the loop cannot return more than its cap), so the fail-loud abort was
  // dead: BootL ended with four TOOL-ENTERABLE pockets (inscribed 2.2-2.9 on a 2.0 tool,
  // 285 mm^2) reading 1.95 and reporting nothing.
  // WO-443: the fail-loud abort judges residualWalker ONLY -- a pocket standing inside the
  // credited band is the finishing contour's assignment, not walker abandonment. THE
  // QUARANTINED CAVEAT CARRIES TO THIS CALL SITE UNCHANGED (GOOD-SPEC section 4): this
  // inscribed-radius search under-reports by up to its 0.05 mm step, and it feeds a
  // fail-loud abort, so any consumer of residualMaxInscribedR must account for that step.
  const residualMaxInscribedR = maxInscribedRadius(residualWalker, toolRadius * AP.sampling.residualSearchToolRadii, Math.max(arcTol, AP.sampling.searchResolutionFloorMm))

  // FAIL-LOUD termination accounting: the pass loop can end three ways that are NOT a
  // normal completion -- reseed's no-progress guard, no entry found in the remaining
  // pocket, or MAX_PASSES exhausted (reseedStop still null: the only breaks are
  // aborted/over-cut and reseed-null, each of which records itself). Surface those via
  // stats.aborted ONLY when a gap the tool physically FITS IN remains uncut. Residual
  // made entirely of slivers narrower than the tool (seam triple-points etc.) is the
  // best any tool of this radius can do -- a 600x400 proof run reached 100.0% coverage
  // with 88mm2 of sub-tool slivers and must read as complete, not aborted.
  if (typeof process !== 'undefined' && process.env.RESEED_DEBUG) console.warn(`[reseed-dbg] loop end: pas ${pasCount}/${MAX_PASSES} reseedStop ${reseedStop} aborted ${aborted ?? 'no'} residual ${residualArea.toFixed(1)} inscribed ${residualMaxInscribedR}`)
  if (!aborted && reseedStop !== 'complete') {
    const meaningfulResidual = residualMaxInscribedR > toolRadius
    if (meaningfulResidual) aborted = reseedStop ?? 'max-passes'
  }

  const cs = tool.cacheStats()
  const routedLoopbackPassIndices: number[] = []
  for (let index = 0; index < passes.length; index++) if (ROUTED_LOOPBACKS.has(passes[index])) routedLoopbackPassIndices.push(index)
  return {
    startPoint,
    entries,
    passes,
    finishClearedRegions,
    finishPassOffsets,
    finishApproaches,
    routedLoopbackPassIndices,
    ...(finishFitRegion ? { finishFitRegion } : {}),
    cleared,
    cutRegion,
    residual,
    stats: { passes: passes.filter(p => p.type === 'cut').length, points: totalPoints, cacheHits: cs.hits, cacheMisses: cs.misses, aborted, residualArea, residualWalkerArea, residualFinishBandArea, residualMaxInscribedR },
  }
}

/** WO-1103: how far the relocated seed's saturated disk overlaps the end wall, in stepovers.
 *  See the placement comment inside `endBiasedChannelSeed` -- the overlap is what stops the
 *  spiral leaving the end corners behind it, and the fraction is the middle of the measured
 *  band in which every one of the order's acceptance numbers holds. */
const END_OVERLAP_STEPOVERS = AP.steering.endOverlapStepovers

/** WO-1103. Is `region` a straight channel that `seed` sits in the MIDDLE of, and if so
 *  where should the entry go instead?
 *
 *  THE SHAPE THIS IS ABOUT. `findStartPointIn` seeds at the region's deepest point. In a
 *  long thin pocket that point is the middle, and the spiral grown from it saturates as soon
 *  as it touches both long walls -- on Bar (gt_fix4) at r = 10.65 mm, half the 21.30 mm
 *  width, leaving ~21 mm of pocket standing at EACH end. The walk then has to cross from one
 *  end of that disk to the other over standing stock, and every rung of `appendCutPass`'s
 *  ladder correctly refuses to do it at depth (WO-1100 measured the corridor: 9.21 mm2 of
 *  standing stock, peak 3.417 mm2/mm = 5.8x the keep-down cap, landing disk 59% uncut against
 *  a 5% allowance). So the path lifts. the reference path's entry on the same part is 20.7 mm nearer the
 *  top end and it never turns round. The seam is not a bad rung -- it is a bad start point.
 *
 *  THE TEST, and why it is this narrow. Grow the disk that fits at `seed` by one stepover --
 *  past saturation -- and look at what is left:
 *    - EXACTLY TWO surviving lobes, each at least the saturated disk's own area. Two says the
 *      disk spans the full width (a channel); "each at least a disk" throws out the crumb a
 *      corner leaves behind (SquareIsland strands 70 mm2 against a 1309 mm2 disk).
 *    - the two lobes lie nearly OPPOSITE each other about the seed (unit vectors to their
 *      centroids dotting <= -0.9). This is the load-bearing condition: relocating to one end
 *      only removes the seam if working one way from that end sweeps the whole region. In a
 *      bent or branched pocket (Boomerang dots -0.20, Tee -0.14, Triangle -0.40) the stranded
 *      lobes point different ways, moving the entry just moves the seam, and this declines.
 *    - each lobe reaches more than a stepover past the disk along that axis -- below that
 *      there is no pass left to strand and nothing to fix.
 *  Measured over the nine gt fixtures at both settings banks, Bar is the only region that
 *  passes (dot -1.000, lobes 468/468 mm2 against a 356 mm2 disk); the other eight are
 *  declined by a wide margin and stay byte-identical.
 *
 *  WHERE IT PUTS THE ENTRY. `END_OVERLAP_STEPOVERS` of a stepover PAST the point where the
 *  saturated disk would be tangent to the end wall, so the disk overlaps the end and the
 *  spiral sweeps the end corners itself instead of leaving them behind (see the comment at
 *  the placement below -- that overlap is what takes Bar's lift count to zero, and tangency
 *  alone does not, which is why we do not simply copy the reference path's drill point).
 *  On Bar at the corpus settings that is (132.68, -19.81), 1.35 mm from the reference path's
 *  (132.68, -21.16) -- inside one 1.60 mm stepover, as WO-1103 requires.
 *  The end is chosen by the axis's canonical sign (+y, else +x), never by lobe order, so a
 *  symmetric channel like Bar does not depend on an area tie-break.
 *
 *  Returns null -- keep the deepest-point seed -- for every region that is not this shape,
 *  and whenever the relocated point cannot be made a legal tool centre with `minInscribe` of
 *  clearance. */
function endBiasedChannelSeed(region: Loops, validTree: PolyNode[], seed: Pt, minInscribe: number, stepOverDistance: number, arcTol: number): Pt | null {
  if (region.length === 0 || stepOverDistance <= 0) return null
  const clearance = closestPointOnPaths(region, seed).dist
  // No room to slide: the seed is already as tight as the helix needs.
  if (!(clearance > minInscribe + stepOverDistance)) return null

  const stranded = difference(region, diskPath(seed, clearance + stepOverDistance, arcTol))
  if (stranded.length === 0) return null
  const diskArea = Math.PI * clearance * clearance
  const lobes: { area: number; c: Pt; loop: Loop }[] = []
  for (const node of offsetClosedTree(stranded, 0, arcTol)) {
    if (node.isHole) continue
    const loops: Loops = [node.contour, ...node.children.filter(child => child.isHole).map(child => child.contour)]
    const area = Math.abs(netArea(loops))
    if (area >= diskArea) lobes.push({ area, c: centroid(node.contour), loop: node.contour })
  }
  if (lobes.length !== 2) return null

  const unit = (p: Pt): Pt | null => {
    const d = magnitude(sub(p, seed))
    return d > 1e-9 ? { x: (p.x - seed.x) / d, y: (p.y - seed.y) / d } : null
  }
  const u0 = unit(lobes[0].c), u1 = unit(lobes[1].c)
  if (!u0 || !u1) return null
  if (u0.x * u1.x + u0.y * u1.y > -0.9) return null

  // The channel axis, signed canonically (+y, or +x when the axis is horizontal) so the end
  // chosen never depends on which lobe clipper happened to hand back first.
  let axis = normalize(sub(lobes[0].c, lobes[1].c))
  if (magnitude(axis) < 0.5) return null
  if (axis.y < -1e-9 || (Math.abs(axis.y) <= 1e-9 && axis.x < 0)) axis = { x: -axis.x, y: -axis.y }
  const along = (p: Pt): number => (p.x - seed.x) * axis.x + (p.y - seed.y) * axis.y

  // Both lobes must reach more than a stepover past the saturated disk, one each way.
  let reachPlus = -Infinity, reachMinus = -Infinity
  for (const lobe of lobes) {
    let far = 0
    for (const p of lobe.loop) { const t = along(p); if (Math.abs(t) > Math.abs(far)) far = t }
    if (far > 0) reachPlus = Math.max(reachPlus, far - clearance)
    else reachMinus = Math.max(reachMinus, -far - clearance)
  }
  if (!(reachPlus > stepOverDistance && reachMinus > stepOverDistance)) return null

  let end = -Infinity
  for (const loop of region) for (const p of loop) { const t = along(p); if (t > end) end = t }
  // PAST TANGENCY, NOT AT IT -- that is the geometric half of the placement. Put the centre
  // `clearance` in from the end and the saturated disk merely KISSES the end wall at a single
  // point, so the spiral leaves a corner triangle either side of that point -- work behind the
  // walk, which it then has to turn round and come back for. That is the same lift in a new
  // place (measured on Bar at the corpus settings: tangent placement, which is also where
  // the reference path drills, still lifts once -- a 9.5 mm hop, then the walk runs back up the closed
  // end). Pull the centre in so the disk OVERLAPS the end and the spiral's own outermost ring
  // sweeps those corners as it grows, leaving nothing behind it.
  //
  // HOW FAR PAST IS MEASURED, NOT ARGUED. The geometry fixes the sign and the scale of the
  // overlap -- of order a stepover -- but not the exact fraction, because the walker's
  // response to the seed is a step function, not a smooth one: it re-plans whole passes. So
  // the interval was mapped on Bar at the corpus settings, 0.01 mm at a time across
  // [9.24, 9.52] mm of inset (WO-1103 fix round; the table is in the card). Every one of
  // WO-1103's acceptance numbers -- zero lifts, entry within one stepover of the reference path's, widest
  // cut under the setpoint, cut count within 10% of the reference path's 38, total cut length no longer
  // than the old path's -- holds across the whole of [9.33, 9.44] and fails at isolated points
  // outside it (9.28 and 9.32 run long; 9.45, 9.50 and 9.52 lift once). Four fifths of a
  // stepover of overlap puts the centre at 9.37 mm, the middle of that band. Never closer to
  // the end than the helix itself needs.
  const target = end - Math.max(clearance - END_OVERLAP_STEPOVERS * stepOverDistance, minInscribe)
  if (target <= 0) return null

  // Slide out along the axis, and if the far end is tighter than the helix needs, walk back
  // until the point is a legal tool centre again. Never return the seed itself: that is the
  // caller's own answer and it says "declined" more honestly as null.
  const step = Math.max(arcTol * AP.sampling.slideStepArcTols, stepOverDistance / AP.sampling.slideStepStepoverDivisor)
  for (let t = target; t > 0; t -= step) {
    const candidate = { x: seed.x + axis.x * t, y: seed.y + axis.y * t }
    if (isOutsideCutRegion(candidate, validTree)) continue
    if (closestPointOnPaths(region, candidate).dist < minInscribe) continue
    return candidate
  }
  return null
}

/** Find a tool-centre entry inside `searchLoops` by decremental inward offsetting: the
 *  deepest inscribable point whose centre is a valid tool position (inside the
 *  machinable region `validTree`). Returns the point, the disk it bores, and that
 *  disk's radius. Generalises FreeCAD findStartPoint to any search region -- used for
 *  both the first entry and for re-seeding into leftover uncut pockets. */
function findStartPointIn(searchLoops: Loops, validTree: PolyNode[], minInscribe: number, seedRadius: number | undefined, toolRadius: number, arcTol: number): { pt: Pt; seedDisk: Loops; seedRadius: number } | null {
  if (searchLoops.length === 0) return null
  const bb = polyBBoxOf(searchLoops)
  const maxLen = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY)
  let startingOffset = maxLen / 2
  const step = toolRadius / AP.sampling.startSearchStepDivisor
  // Always sample the requested minimum exactly. A fixed decrement can jump
  // from just above the minimum to below it and miss the only valid interval
  // in a tight region.
  const probe = (offset: number): Pt | null => {
    const offsetPaths = offsetClosed(searchLoops, -offset, arcTol)
    for (const path of offsetPaths) {
      // Prefer the centroid (a central helix spot); but for an annular/holey region the
      // centroid lands in a hole, so fall back to a vertex of the offset path, which is
      // >= offset inside the region by construction.
      let pt = centroid(path)
      if (isOutsideCutRegion(pt, validTree)) pt = path[0]
      if (!isOutsideCutRegion(pt, validTree)) return pt
    }
    return null
  }
  let lastFailing = Number.POSITIVE_INFINITY
  // WO-3024: the rungs above the region's clearance each cost a full inward offset that comes
  // back empty (34 s on the Form cylinder, mostly re-seeds into small leftovers). Erosion only
  // shrinks as the offset grows, so the highest non-empty rung is found by bisection over the
  // same rung values (built with the same arithmetic) and the walk resumes one rung above it:
  // that rung, every later one, the bisection below and its `lastFailing` are what the full
  // walk would have seen. Rungs closer together than the offset's own arc tolerance keep the
  // full walk.
  if (step > 8 * arcTol) {
    const rungs: number[] = []
    for (let r = startingOffset; ; r = Math.max(minInscribe, r - step)) {
      if (r < minInscribe) break
      rungs.push(r)
      if (r === minInscribe) break
    }
    if (rungs.length > 4) {
      let lo = 0, hi = rungs.length // first non-empty rung lies in [lo, hi]; hi = none
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (offsetClosed(searchLoops, -rungs[mid], arcTol).length > 0) hi = mid
        else lo = mid + 1
      }
      const resume = Math.max(0, Math.min(lo, rungs.length - 1) - 1)
      if (resume > 0) {
        lastFailing = rungs[resume - 1]
        startingOffset = rungs[resume]
      }
    }
  }
  while (startingOffset >= minInscribe) {
    let pt = probe(startingOffset)
    if (pt) {
      let foundOffset = startingOffset
      // The rungs are toolRadius/4 apart, so the true clearance is anywhere in
      // [foundOffset, lastFailing). When the coarse rung lands BELOW the helix
      // floor and the search is asking for the region's own clearance (no fixed
      // seedRadius), bisect that interval: most of it usually sits above the
      // floor, and a fitting helix beats a plunge. Gated so every entry the
      // coarse rung already served stays byte-identical.
      if (seedRadius === undefined && foundOffset < MIN_DESCENT_HELIX_RADIUS
        && Number.isFinite(lastFailing)) {
        let lo = foundOffset
        let hi = lastFailing
        let bestPt = pt
        for (let iter = 0; iter < 8 && hi - lo > MIN_DESCENT_HELIX_RADIUS / 8; iter++) {
          const mid = (lo + hi) / 2
          const midPt = probe(mid)
          if (midPt) { lo = mid; bestPt = midPt } else { hi = mid }
        }
        foundOffset = lo
        pt = bestPt
      }
      const actualSeedRadius = seedRadius ?? toolRadius + foundOffset
      return {
        pt,
        seedDisk: diskPath(pt, actualSeedRadius, arcTol),
        seedRadius: actualSeedRadius,
      }
    }
    lastFailing = startingOffset
    if (startingOffset === minInscribe) break
    startingOffset = Math.max(minInscribe, startingOffset - step)
  }
  return null
}

/** Split an even-odd region into connected material components while keeping each outer
 * contour's direct holes attached. A nested material island inside a hole is its own
 * component. WO-464 uses this only after the walk has decided all remaining components are
 * below the legal descent floor, so it is evidence bookkeeping rather than a motion gate. */
function materialComponents(region: Loops, arcTol: number): Loops[] {
  const components: Loops[] = []
  const visit = (node: PolyNode): void => {
    if (node.isHole) {
      for (const child of node.children) visit(child)
      return
    }
    const holes = node.children.filter(child => child.isHole)
    components.push([node.contour, ...holes.map(hole => hole.contour)])
    for (const hole of holes) {
      for (const island of hole.children) visit(island)
    }
    // PolyTree nesting normally alternates material/hole, but retain any direct material
    // child defensively instead of letting a malformed tree hide it from the census.
    for (const child of node.children) {
      if (!child.isHole) visit(child)
    }
  }
  for (const root of offsetClosedTree(region, 0, arcTol)) visit(root)
  return components.length > 0 ? components : [region]
}

/** WO-465. One tool-centre component this run declined to make a region of, plus the two
 *  numbers that justify the decision and the stage that took it. */
interface DroppedComponent { loops: Loops; toolCentreArea: number; largestEntryRadius: number; stage: DroppedSliverStage }

/** Group `cutRegion`'s OWN loops into material components without rebuilding them.
 *  materialComponents() re-runs offsetClosedTree and hands back freshly reconstructed
 *  contours; the walker, every emitted pass and every byte-stability pin read the loops
 *  offsetClosed produced, so this grouping keeps those exact objects and their order and
 *  returns indices into the original array. Positive area = outer contour, negative = hole
 *  -- the same convention wallBandContour's skipOuterBoundaryCleanup filter already relies
 *  on. A hole is attributed to the SMALLEST outer containing it, so an island nested inside
 *  a hole keeps its own holes rather than stealing its parent's. A loop no outer contains
 *  is left unattributed and therefore never dropped. */
function groupCutRegionComponents(cutRegion: Loops): { outer: number; holes: number[] }[] {
  const outers: { idx: number; area: number }[] = []
  for (let i = 0; i < cutRegion.length; i++) {
    const a = loopArea(cutRegion[i])
    if (a > 0) outers.push({ idx: i, area: a })
  }
  const comps = outers.map(o => ({ outer: o.idx, holes: [] as number[] }))
  for (let i = 0; i < cutRegion.length; i++) {
    if (loopArea(cutRegion[i]) > 0 || cutRegion[i].length === 0) continue
    let best = -1
    for (let c = 0; c < outers.length; c++) {
      if (pip2(cutRegion[i][0], cutRegion[outers[c].idx]) < 0) continue
      if (best < 0 || outers[c].area < outers[best].area) best = c
    }
    if (best >= 0) comps[best].holes.push(i)
  }
  return comps
}

/** WO-465 PREVENTION. Drop every cutRegion component that cannot accept the engine's
 *  smallest legal descent, so no region is ever formed there.
 *
 *  The test is the exact yes/no one WO-464 proved is the right question: findStartPointIn
 *  in REQUESTED-SIZE mode (fixed seedRadius = toolRadius + MIN_DESCENT_HELIX_RADIUS)
 *  samples that radius EXACTLY, with no bisection bracket to round the wrong way. The
 *  approximate capacity search runs only after the decision, purely to report how much
 *  room there actually was.
 *
 *  Two refusals to act, both deliberate:
 *    - a single-component cutRegion is returned untouched. Nothing about a one-region
 *      feature is a sliver problem; leaving it alone keeps findEntry's 'no-start-point'
 *      contract and WO-464's unchanged-first-entry promise exactly as they were.
 *    - the filter never empties cutRegion. If every component fails, the feature is simply
 *      too small for this tool and the existing entry path must be the one to say so. */
function dropUnenterableCutRegionComponents(
  cutRegion: Loops,
  cutTree: PolyNode[],
  toolRadius: number,
  tolerance: number,
  arcTol: number,
): { cutRegion: Loops; dropped: DroppedComponent[] } {
  const comps = groupCutRegionComponents(cutRegion)
  if (comps.length < 2) return { cutRegion, dropped: [] }
  const dropped: DroppedComponent[] = []
  const droppedLoops = new Set<number>()
  for (const comp of comps) {
    const loops: Loops = [cutRegion[comp.outer], ...comp.holes.map(h => cutRegion[h])]
    const legal = findStartPointIn(
      loops, cutTree, MIN_DESCENT_HELIX_RADIUS, toolRadius + MIN_DESCENT_HELIX_RADIUS, toolRadius, arcTol,
    )
    if (legal) continue
    const capacity = findStartPointIn(loops, cutTree, Math.max(tolerance * AP.sampling.seedSearchTolerances, arcTol), undefined, toolRadius, arcTol)
    dropped.push({
      loops,
      toolCentreArea: Math.abs(netArea(loops)),
      largestEntryRadius: Math.max((capacity?.seedRadius ?? toolRadius) - toolRadius, 0),
      stage: 'cut-region',
    })
    droppedLoops.add(comp.outer)
    for (const h of comp.holes) droppedLoops.add(h)
  }
  if (dropped.length === 0 || droppedLoops.size >= cutRegion.length) return { cutRegion, dropped: [] }
  return { cutRegion: cutRegion.filter((_, i) => !droppedLoops.has(i)), dropped }
}

/** Radius of the largest disk that fits anywhere in `region`, found by decremental
 *  inward offsetting. Half the worst gap width: ~arcTol when a pocket is truly clean,
 *  but jumps to ~half-a-tool when a real uncut seam/cusp remains. */
function maxInscribedRadius(region: Loops, maxR: number, step: number): number {
  if (region.length === 0) return 0
  let best = 0
  for (let d = step; d <= maxR; d += step) {
    if (offsetClosed(region, -d).length === 0) break
    best = d
  }
  return best
}

/** B8 ENGAGEMENT GATE for a candidate stay-down connection ride (integral wall-follow).
 *
 *  boundaryArcBetween only proves the ride's two endpoints share a boundary loop -- it says
 *  NOTHING about the material along the ride. Substituting it for a lift without
 *  revalidation let a ride slot FULL-WIDTH through uncleared stock (bug B8; violates R1
 *  material safety / R2 optimal load -- AC-SPEC rules 1 and 2).
 *
 *  Method: sweep the ride with full-toolRadius capsules INCREMENTALLY (each step's freshly
 *  removed area is measured against an accumulator that grows with the ride, so material
 *  the ride itself just removed is not double-counted) and convert to effective cut width =
 *  fresh area / step length. Trip only on a SUSTAINED overload: a contiguous window of
 *  >= WINDOW mm of path whose AVERAGE effective width exceeds `cap`. The windowed average
 *  (not the per-step max) is what makes the metric robust to single-step quantization
 *  spikes: a near-zero-length resample step grazing a sliver reads an absurd instantaneous
 *  width (tiny area / tinier length) while removing no real material -- averaged over a
 *  2mm window its area contribution vanishes. A genuine slot carries cap-level area for
 *  every one of those 2mm. Rides shorter than WINDOW are judged as a single window with
 *  the denominator clamped to WINDOW: a short full-slot punch (>= cap*WINDOW mm^2 of
 *  uncut) still trips; a grazing spike cannot. Deterministic: pure geometry (clipper
 *  booleans), no RNG, no time, no global state.
 *
 *  Returns the tripping window's average width + location for the fail-loud report, or
 *  null when the ride is safe to keep down. */
export function rideOverloadsUncut(ride: Pt[], cleared: Loops, toolRadius: number, cap: number, arcTol: number): { width: number; at: Pt; sStart: number; sEnd: number; rideLen: number } | null {
  if (ride.length < 2) return null
  const fast = rideOverloadsUncutBy(ride, cleared, toolRadius, cap, arcTol, RIDE_MEASURE.local)
  if (fast !== NEAR_TIE) return fast
  RIDE_MEASURE.nearTies++
  return rideOverloadsUncutBy(ride, cleared, toolRadius, cap, arcTol, false) as ReturnType<typeof rideOverloadsUncut>
}

// WO-3024: the ride measures below are what the Form cylinder and the knob spent half their
// planning time in. They now (1) scan lazily -- a ride stops being measured at its first
// tripping window, which is where the scan always returned -- (2) keep the growing cleared set
// in wasm between sub-steps (capsuleSweep), and (3) when `local`, hand Clipper only the part of
// the cleared set the rest of the ride can reach (clearedNear), and skip the stretches of a long
// ride a cheap bound proves hold no tripping window (provenSafeStretches). (1) and (2) are the same Clipper
// calls on the same inputs. (3) is the same region, but Clipper's integer sweep rounds an
// intersection by the scanlines of the whole input, so a measured width can move in its sixth
// significant digit. So every comparison against a cap is checked for a near tie, and a near
// tie is measured again with `local` off -- the full set, exactly as before -- and that answer
// is the one returned. Every decision is therefore the one the full measure makes.
const NEAR_TIE = Symbol('near-tie')
/** Test oracle only: `local: false` measures every ride against the whole cleared set, step by
 *  step, as before WO-3024; the planned result must not change (adaptiveSpeed.wo3024.test.ts).
 *  The counts say how often the fast measure skipped steps and re-measured a near tie. */
export const RIDE_MEASURE = { local: true, skippedSteps: 0, nearTies: 0 }
const NEAR_TIE_WIDTH_MM = 1e-4 // a measured width (mm^2/mm) this close to its cap is re-measured
const nearTie = (value: number, cap: number, scale = 1): boolean => Math.abs(value - cap) <= NEAR_TIE_WIDTH_MM * scale

function rideOverloadsUncutBy(ride: Pt[], cleared: Loops, toolRadius: number, cap: number, arcTol: number, local: boolean): { width: number; at: Pt; sStart: number; sEnd: number; rideLen: number } | null | typeof NEAR_TIE {
  const WINDOW = AP.sampling.rideWindowMm // mm of sustained path length

  // Cheap short-circuit: a tripping window must remove > cap*WINDOW mm^2 of uncut material,
  // so if the WHOLE ride's corridor removes no more than that, no window can trip. This
  // skips the per-step boolean loop for the common legitimate ride -- the wall-cleanup skim
  // along a thin (sub-stepover) uncut wall sliver.
  const base = local ? clearedNear(cleared, ride, toolRadius, arcTol) : cleared
  const corridor = offsetOpenRound(ride, toolRadius, arcTol)
  const corridorUncut = difference(corridor, base)
  const corridorArea = totalArea(corridorUncut)
  if (local && nearTie(corridorArea, cap * WINDOW, WINDOW)) return NEAR_TIE
  if (corridorArea <= cap * WINDOW) return null

  // Per-step freshly-removed area against the growing accumulator, measured as far as the
  // window scan needs it.
  const sweep = rideSweep(resampleRide(ride), base, toolRadius, arcTol, local)
  try {
    const { stepLen, stepMid } = sweep
    const n = stepLen.length
    const safeUntil = local ? provenSafeStretches(corridorUncut, sweep, toolRadius, arcTol, cap * WINDOW, WINDOW) : null
    // Sliding minimal window of >= WINDOW mm (two-pointer): trip when the window's area
    // density (mm^2 per mm = average effective width) exceeds the cap. Tail windows shorter
    // than WINDOW keep the WINDOW denominator (the short-ride clamp described above).
    const rideLen = stepLen.reduce((s, l) => s + l, 0)
    let i = 0, j = 0, lenSum = 0, areaSum = 0, sCursor = 0
    while (i < n) {
      const next = safeUntil ? safeUntil(i) : i
      if (next > i) {
        // No window starting before `next` can trip: skip to it and restart the window there.
        RIDE_MEASURE.skippedSteps += next - i
        for (; i < next; i++) sCursor += stepLen[i]
        j = i; lenSum = 0; areaSum = 0
        continue
      }
      while (j < n && lenSum < WINDOW) { lenSum += stepLen[j]; areaSum += sweep.areaAt(j); j++ }
      const width = areaSum / Math.max(lenSum, WINDOW)
      if (local && nearTie(width, cap)) return NEAR_TIE
      if (width > cap) return { width, at: stepMid[i], sStart: sCursor, sEnd: sCursor + lenSum, rideLen }
      lenSum -= stepLen[i]; areaSum -= sweep.areaAt(i)
      sCursor += stepLen[i]
      i++
    }
    return null
  } finally { sweep.dispose() }
}

/** WO-3024: stretches of a ride that provably hold no tripping window. The ride's steps are cut
 *  into chunks at least one window (plus its longest step) long, so every window that starts in
 *  chunk c ends by the end of chunk c+1. A window's fresh area is at most the area its capsules
 *  cover outside the cleared set. Those capsules lie in a corridor round chunks c and c+1 drawn
 *  two arc tolerances wider than the tool, and in the ride's true swept band. The ride's own
 *  uncleared corridor (the short-circuit's `difference`) misses that band only by the slivers
 *  between its round joins and their arcs, each at most an arc tolerance deep, so at most
 *  arcTol x r x (turning + a full turn for the ends) in area. So the window's fresh area is at
 *  most (uncleared corridor within the chunk corridor) + that sliver allowance. When that bound
 *  sits clearly under the trip area (cap x WINDOW) and has no hole (a cleared island inside
 *  the corridor, which the per-step area would count), no window starting in chunk c trips and
 *  the scan may jump to chunk c+1 without measuring a step. A chunk no uncleared piece comes near
 *  needs no Clipper call. Returns, for a step index, the first step the scan must still look
 *  at. */
const RIDE_CHUNK_MIN_MM = 6 // shortest chunk; long enough that one bound covers several windows
const RIDE_BOUND_MARGIN_MM2 = 1e-2 // the bound must clear the trip area by this much
function provenSafeStretches(uncutLoops: Loops, sweep: RideSweep, toolRadius: number, arcTol: number, tripArea: number, WINDOW: number): (i: number) => number {
  const { stepLen, stepA, stepB } = sweep
  const n = stepLen.length
  const chunkLen = Math.max(RIDE_CHUNK_MIN_MM, WINDOW + Math.max(0, ...stepLen))
  const starts: number[] = [0]
  const chunkOf = new Int32Array(n)
  let run = 0
  for (let k = 0; k < n; k++) {
    if (run >= chunkLen) { starts.push(k); run = 0 }
    chunkOf[k] = starts.length - 1
    run += stepLen[k]
  }
  starts.push(n)
  const chunkR = toolRadius + 2 * arcTol
  const uncutBoxes = uncutLoops.map(l => polyBBoxOf([l]))
  const safe = new Map<number, boolean>()
  return (i: number): number => {
    const c = chunkOf[i]
    let ok = safe.get(c)
    if (ok === undefined) {
      const from = starts[c], to = starts[Math.min(c + 2, starts.length - 1)]
      const path = [stepA[from], ...stepB.slice(from, to)]
      let turning = 2 * Math.PI
      for (let k = 1; k + 1 < path.length; k++) {
        const a = path[k - 1], b = path[k], d = path[k + 1]
        turning += Math.abs(Math.atan2((b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x), (b.x - a.x) * (d.x - b.x) + (b.y - a.y) * (d.y - b.y)))
      }
      const room = tripArea - RIDE_BOUND_MARGIN_MM2 - arcTol * toolRadius * turning
      const pb = polyBBoxOf([path])
      const box = { minX: pb.minX - chunkR, minY: pb.minY - chunkR, maxX: pb.maxX + chunkR, maxY: pb.maxY + chunkR }
      const near = uncutLoops.filter((_, k) => !boxesMiss(uncutBoxes[k], box))
      // Whole pieces first: if every uncleared piece the chunk comes near is small, so is the part
      // of them the chunk can cover.
      const whole = near.reduce((sum, l) => sum + Math.abs(loopArea(l)), 0)
      if (room <= 0) ok = false
      else if (whole <= room) ok = true
      else {
        const piece = intersection(offsetOpenRound(path, chunkR, arcTol), near)
        const area = totalArea(piece)
        ok = area <= room && Math.abs(area - netArea(piece)) <= RIDE_BOUND_MARGIN_MM2
      }
      safe.set(c, ok)
    }
    return ok ? starts[c + 1] : i
  }
}
const boxesMiss = (a: Box, b: Box): boolean => a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY

/** Resample at <= ds spacing (keeping original vertices) so window content does not depend
 *  on the boundary polyline's vertex spacing. */
function resampleRide(ride: Pt[]): Pt[] {
  const ds = AP.sampling.rideResampleMm
  const pts: Pt[] = [ride[0]]
  for (let i = 1; i < ride.length; i++) {
    const a = ride[i - 1], b = ride[i]
    const L = Math.hypot(b.x - a.x, b.y - a.y)
    const n = Math.max(1, Math.ceil(L / ds))
    for (let k = 1; k <= n; k++) pts.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n })
  }
  return pts
}

/** The windowed ride measure's sub-steps: each step's fresh area is its capsule minus the
 *  accumulator, then the capsule is unioned in, in step order. Steps are measured on demand.
 *  When `local`, every RIDE_LOCAL_EVERY steps the accumulator is cut down to the boxes of the
 *  steps still to come (clearedNearBoxes), so neither the corridor already swept nor cleared
 *  ground the rest of the ride cannot reach rides along through every Clipper call. */
const RIDE_LOCAL_EVERY = 8
interface RideSweep { stepLen: number[]; stepMid: Pt[]; stepA: Pt[]; stepB: Pt[]; areaAt: (k: number) => number; dispose: () => void }
function rideSweep(pts: Pt[], cleared: Loops, toolRadius: number, arcTol: number, local: boolean): RideSweep {
  const as: Pt[] = [], bs: Pt[] = []
  const stepLen: number[] = []
  const stepMid: Pt[] = []
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const L = Math.hypot(b.x - a.x, b.y - a.y)
    if (L < 1e-9) continue
    as.push(a); bs.push(b)
    stepLen.push(L)
    stepMid.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  }
  const stepArea: number[] = []
  const acc = capsuleSweep(cleared)
  const trim = (s: number): void => {
    const boxes: Box[] = []
    for (let c = s; c < as.length; c += RIDE_LOCAL_EVERY) boxes.push(polyBBoxOf([[...as.slice(c, c + RIDE_LOCAL_EVERY), ...bs.slice(c, c + RIDE_LOCAL_EVERY)]]))
    const now = acc.read()
    const near = clearedNearBoxes(now, boxes, toolRadius, arcTol)
    if (near !== now) acc.write(near)
  }
  // Steps the scan proved hold no trip and skipped (only when `local`). Their capsules still
  // belong to the cleared set: each joins it before the first measured step it comes near.
  const skipped: number[] = []
  const areaAt = (k: number): number => {
    for (let s = stepArea.length; s < k; s++) { skipped.push(s); stepArea.push(NaN) }
    while (stepArea.length <= k) {
      const s = stepArea.length
      if (local && s > 0 && s % RIDE_LOCAL_EVERY === 0) trim(s)
      if (skipped.length > 0) {
        const reach = 2 * toolRadius + 4 * arcTol + 1e-3
        const minX = Math.min(as[s].x, bs[s].x) - reach, maxX = Math.max(as[s].x, bs[s].x) + reach
        const minY = Math.min(as[s].y, bs[s].y) - reach, maxY = Math.max(as[s].y, bs[s].y) + reach
        const join: [Pt, Pt][] = []
        for (let q = skipped.length - 1; q >= 0; q--) {
          const t = skipped[q], a = as[t], b = bs[t]
          if (Math.max(a.x, b.x) < minX || Math.min(a.x, b.x) > maxX || Math.max(a.y, b.y) < minY || Math.min(a.y, b.y) > maxY) continue
          join.push([a, b]); skipped.splice(q, 1)
        }
        acc.absorb(join, toolRadius, arcTol)
      }
      stepArea.push(acc.step(as[s], bs[s], toolRadius, arcTol))
    }
    return stepArea[k]
  }
  return { stepLen, stepMid, stepA: as, stepB: bs, areaAt, dispose: () => acc.dispose() }
}

// WO-3024: `cleared` as the ride's corridor sees it. Even-odd fill decides each point by the
// parity of the loops around it, so any edit to `cleared` that keeps that parity at every point
// of the corridor's box leaves every boolean the ride measures the same region, built from the
// same edges. Two such edits: a loop that misses the box and does not enclose it is dropped,
// and a run of edges that never enters the box is replaced by its chord when run and chord
// together wind zero times round the box (else the run is halved and each half tried). The
// edges that enter the box are kept exactly. The measure then stops dragging the whole level's
// cleared set through Clipper once per 0.75 mm sub-step.
interface Box { minX: number; minY: number; maxX: number; maxY: number }
const segMissesBox = (a: Pt, b: Pt, box: Box): boolean =>
  Math.max(a.x, b.x) < box.minX || Math.min(a.x, b.x) > box.maxX || Math.max(a.y, b.y) < box.minY || Math.min(a.y, b.y) > box.maxY
/** Winding number of the closed polygon lp[from..to] (indices taken cyclically) round `c`. */
function windingOfRun(lp: Loop, from: number, count: number, c: Pt): number {
  let w = 0
  for (let k = 0; k < count; k++) {
    const a = lp[(from + k) % lp.length], b = lp[(from + (k + 1) % count) % lp.length]
    if (a.y <= c.y) { if (b.y > c.y && (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y) > 0) w++ }
    else if (b.y <= c.y && (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y) < 0) w--
  }
  return w
}
function clearedNear(cleared: Loops, ride: Pt[], toolRadius: number, arcTol: number): Loops {
  return clearedNearBoxes(cleared, [polyBBoxOf([ride])], toolRadius, arcTol)
}
/** clearedNear for the union of several boxes (each padded by a tool radius): the run test and
 *  the chord test hold for every box, and a closed run + chord that avoids them all has one
 *  winding number per box, so it is checked at each box's centre. */
function clearedNearBoxes(cleared: Loops, rawBoxes: Box[], toolRadius: number, arcTol: number): Loops {
  const pad = toolRadius + 4 * arcTol + 1e-3
  const boxes = rawBoxes.map(r => ({ minX: r.minX - pad, minY: r.minY - pad, maxX: r.maxX + pad, maxY: r.maxY + pad }))
  const hull = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const r of boxes) {
    hull.minX = Math.min(hull.minX, r.minX); hull.minY = Math.min(hull.minY, r.minY)
    hull.maxX = Math.max(hull.maxX, r.maxX); hull.maxY = Math.max(hull.maxY, r.maxY)
  }
  const centres = boxes.map(r => ({ x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 }))
  const missesAll = (a: Pt, b: Pt): boolean => {
    if (segMissesBox(a, b, hull)) return true
    for (const r of boxes) if (!segMissesBox(a, b, r)) return false
    return true
  }
  const out: Loops = []
  let changed = false
  for (const lp of cleared) {
    const n = lp.length
    const keep = new Uint8Array(n)
    let kept = 0
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      if (!missesAll(lp[i], lp[j])) { if (!keep[i]) { keep[i] = 1; kept++ } if (!keep[j]) { keep[j] = 1; kept++ } }
    }
    if (kept === n) { out.push(lp); continue }
    changed = true
    if (kept === 0) {
      // Wholly outside every box: it adds parity 1 or 0 to each box. All 0: dropped. All 1: one
      // rectangle round them all. Mixed: kept as it is.
      const odd = centres.map(c => windingOfRun(lp, 0, n, c) % 2 !== 0)
      if (odd.every(o => !o)) continue
      if (odd.every(o => o)) out.push([{ x: hull.minX - pad, y: hull.minY - pad }, { x: hull.maxX + pad, y: hull.minY - pad }, { x: hull.maxX + pad, y: hull.maxY + pad }, { x: hull.minX - pad, y: hull.maxY + pad }])
      else out.push(lp)
      continue
    }
    // Each run of dropped vertices between two kept ones (k1 .. k2) is replaced by chords.
    const simplified: Pt[] = []
    let first = 0
    while (!keep[first]) first++
    // A chord in line with the kept edge beside it would let Clipper merge the two, which
    // moves that edge's far end; such a run is split instead.
    const inLine = (p: Pt, q: Pt, r: Pt): boolean => {
      const cross = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x)
      return Math.abs(cross) <= 1e-9 * (Math.hypot(q.x - p.x, q.y - p.y) * Math.hypot(r.x - q.x, r.y - q.y) + 1e-12)
    }
    const emitRun = (k1: number, span: number): void => {
      // lp[k1] then the vertices up to (excluding) lp[k1 + span]; chord k1 -> k1 + span tried first.
      const k2 = (k1 + span) % n
      if (span <= 1) { simplified.push(lp[k1]); return }
      if (missesAll(lp[k1], lp[k2]) && centres.every(c => windingOfRun(lp, k1, span + 1, c) === 0)
        && !inLine(lp[(k1 - 1 + n) % n], lp[k1], lp[k2]) && !inLine(lp[k1], lp[k2], lp[(k2 + 1) % n])) { simplified.push(lp[k1]); return }
      const half = Math.floor(span / 2)
      emitRun(k1, half)
      emitRun((k1 + half) % n, span - half)
    }
    let i = first
    do {
      let span = 1
      while (!keep[(i + span) % n]) span++
      emitRun(i, span)
      i = (i + span) % n
    } while (i !== first)
    out.push(simplified)
  }
  return changed ? out : cleared
}

/** WO-410: TOTAL over-cap length of a ride (same incremental windowed measure as
 *  rideOverloadsUncut, but accumulated over the whole ride instead of returning at the
 *  first tripping window). Used by the finishing-contour rim refusal, which mirrors the
 *  3D engagement gate's contract: peak vs cap plus an over-cap LENGTH allowance, so a
 *  2 mm corner transient never fails a region that a 300 mm buried lap must.
 *  WO-1178: `measurePeak` bypasses the safe-area short-circuit so the returned `peak` is the
 *  real windowed measurement (the short-circuit's `peak: 0` is a sentinel that must never be
 *  printed as a measured bite -- WO-1141B audit). `maxStep` is the largest INSTANTANEOUS bite
 *  (one 0.75 mm sub-step's fresh area over its length, against the growing stock), which no
 *  longer ride can dilute: a window average can be met by padding the window with zero-removal
 *  travel, a sub-step bite cannot. */
export function contourOverCap(ride: Pt[], cleared: Loops, toolRadius: number, cap: number, arcTol: number, measurePeak = false): { overLen: number; peak: number; at: Pt; maxStep: number } {
  const none = { overLen: 0, peak: 0, at: ride[0] ?? { x: 0, y: 0 }, maxStep: 0 }
  if (ride.length < 2) return none
  const fast = contourOverCapBy(ride, cleared, toolRadius, cap, arcTol, measurePeak, none, RIDE_MEASURE.local)
  if (fast !== NEAR_TIE) return fast
  RIDE_MEASURE.nearTies++
  return contourOverCapBy(ride, cleared, toolRadius, cap, arcTol, measurePeak, none, false) as typeof none
}
function contourOverCapBy(ride: Pt[], cleared: Loops, toolRadius: number, cap: number, arcTol: number, measurePeak: boolean,
  none: { overLen: number; peak: number; at: Pt; maxStep: number }, local: boolean): { overLen: number; peak: number; at: Pt; maxStep: number } | typeof NEAR_TIE {
  const WINDOW = AP.sampling.rideWindowMm
  // Cheap short-circuit, as rideOverloadsUncut: no window can trip if the whole corridor
  // removes no more than one tripping window's worth of material.
  const base = local ? clearedNear(cleared, ride, toolRadius, arcTol) : cleared
  const corridor = offsetOpenRound(ride, toolRadius, arcTol)
  if (!measurePeak) {
    const corridorArea = totalArea(difference(corridor, base))
    if (local && nearTie(corridorArea, cap * WINDOW, WINDOW)) return NEAR_TIE
    if (corridorArea <= cap * WINDOW) return none
  }
  const sweep = rideSweep(resampleRide(ride), base, toolRadius, arcTol, local)
  let stepArea: number[]
  try { stepArea = sweep.stepLen.map((_, k) => sweep.areaAt(k)) } finally { sweep.dispose() }
  const { stepLen, stepMid } = sweep
  let j = 0, lenSum = 0, areaSum = 0
  let overLen = 0, peak = 0, at = none.at, maxStep = 0
  for (let i = 0; i < stepLen.length; i++) {
    while (j < stepLen.length && lenSum < WINDOW) { lenSum += stepLen[j]; areaSum += stepArea[j]; j++ }
    const width = areaSum / Math.max(lenSum, WINDOW)
    const stepWidth = stepArea[i] / stepLen[i]
    // The callers decide on overLen and maxStep (against this same cap); peak and its
    // position are only reported.
    if (local && (nearTie(width, cap) || nearTie(stepWidth, cap))) return NEAR_TIE
    if (width > peak) { peak = width; at = stepMid[i] }
    if (width > cap) overLen += stepLen[i]
    if (stepWidth > maxStep) maxStep = stepWidth
    lenSum -= stepLen[i]; areaSum -= stepArea[i]
  }
  return { overLen, peak, at, maxStep }
}

/** WO-438's T5 TRAVERSE BOUND, in one place so every rung that travels at depth meets the
 *  IDENTICAL number. "Zero belief-uncut" cannot be measured as literal presence (the
 *  polygon belief's faceting under-counts every swept track, and a ride that ends on the
 *  cut frontier necessarily contains the bite the next cut is about to take), so the bound
 *  is that bite itself: ONE ENGAGE-BAND BITE spread over rideOverloadsUncut's 2 mm window.
 *  maxBite (1.5 x optimal x the walker's engage move) is the largest bite the walker may
 *  hand the stepper -- bounded BY CONSTRUCTION by the progress contract, not chosen here.
 *  Extracted verbatim from rung (b)(4) by WO-466; the arithmetic is unchanged. */
function traverseKeepDownCap(stepOverDistance: number, optimal: number, arcTol: number): number {
  const engageMoveDistance = adaptiveEngageMoveDistance('traverse', stepOverDistance, undefined, arcTol,
    adaptiveKeepDownCapPolicy(ADAPTIVE_MOTION_SWITCHES.keepDownCapForm))
  return Math.max(arcTol, AP.caps.engageBandBiteFactor * optimal * engageMoveDistance / AP.sampling.rideWindowMm)
}

/** WO-466: STAY DOWN, STOP SHORT OF THE SKIN, AND FEED THE LAST BIT.
 *
 *  Operator ruling 2026-08-22, on the WO-449 card: "we want the 'later option' you mentioned to stay
 *  down"; and on the WO-447 card in the same three minutes: "Also look at use of keep down
 *  travel moves to avoid retracts." The option is the one WO-449's own note above
 *  planGatedLanding named and deferred -- "a tier-1 travel that stops SHORT of the skin and
 *  hands the last stretch to a feed-rate lead would be provable".
 *
 *  WHY A WHOLE-CORRIDOR PROOF REFUSES A CONNECTION THAT IS MOSTLY OVER CLEARED GROUND. Every
 *  keep-down rung in this engine judges the corridor as ONE object: one sustained-width
 *  window measure over the whole ride, one verdict. A connection that ENDS AGAINST STANDING
 *  MATERIAL -- a wall-finish lap's start, a pass engage point beside a rim -- therefore fails
 *  on its last millimetres however clear the first 95% is, and the engine concedes a
 *  full-clearance retract to cross ground its own proof had already cleared. Measured on the
 *  nine gt fixtures at CORPUS_STEPOVER=0.4 CORPUS_WALLFINISH=1 CLIMB, all ELEVEN wall-finish
 *  connections read one refusal, verbatim: "corridor load-CLEAR but sweeps 0.01-0.92mm2 of
 *  belief-uncut -- T5 zero-tolerance REFUSES it at traverse speed".
 *
 *  THE SPLIT. Cut the straight chord at the arc coordinate where the TRAVEL proof first
 *  trips. The PREFIX is then re-measured ON ITS OWN at the same zero-tolerance traverse
 *  bound and travels at depth. The SUFFIX is a CUTTING move, so it is held to the bar this
 *  engine already sets for a tier-0 cut-through -- sustained effective width <= 2 x optimal,
 *  length <= 2 x stepover -- and the material it removes is commanded, at feed, exactly as a
 *  cut's is.
 *
 *  NOTHING IS RELAXED, and that is the whole legality argument. The travel half meets the
 *  identical traverse cap a whole-corridor keep-down meets; the fed half meets the identical
 *  cut-through caps; and the WHOLE chord must clear the gouge veto (tool centre inside the
 *  machinable region) before either half is measured, so this can never reintroduce WO-449's
 *  island crossing -- and it can never move material at travel speed, which was the defect.
 *  Where no split proves, the retract STAYS and the refusal is attributed. */
export interface StopShortKeepDown {
  /** At-depth traverse over ground the proof clears: 2 points, starting at `source`. ONE
   *  point (just `source`) when the whole chord is inside the cut-through length bar and
   *  there is nothing to travel -- see the whole-chord case below. Never zero. */
  travel: Pt[]
  /** The engaged tail, fed at cutting feed. Exactly 2 points, ending at `target`. */
  feed: Pt[]
  /** T1 attribution (GOOD-SPEC section 6): the split coordinate and both measured verdicts. */
  reason: string
}

/** Numeric floor for "the travel half sweeps NO belief-uncut". NOT an allowance: at 1e-6 mm2
 *  it is four orders of magnitude below the smallest real sliver the corpus produces (0.01
 *  mm2 on CommaSpiral) and exists only so clipper's integer-coordinate rounding cannot
 *  register a phantom area on a corridor that is geometrically inside cleared stock.
 *  WO-449's zero-tolerance rule is the bar; this is the numerical representation of zero. */
const TRAVEL_BELIEF_UNCUT_EPS = 1e-6

/** Exported for the "WO-466 stop-short keep-down" block in `staydown-engagement.test.ts`,
 *  which pins the tier-0 feed-length ceiling this helper must never exceed. Pure geometry
 *  over caller-supplied proofs -- no engine state -- so the test asserts the contract itself
 *  rather than inferring it from corpus output, which is how the ceiling relaxation the
 *  2026-08-26 audit caught survived a full corpus measurement. */
export function planStopShortKeepDown(args: {
  source: Pt
  target: Pt
  arcTol: number
  /** Gouge veto, applied to the WHOLE chord before either half is measured. */
  gouges: (a: Pt, b: Pt) => boolean
  /** THE CALLER'S OWN TRAVEL-SPEED PROOF, asked about a candidate prefix. Null means proven
   *  clear; a string is the measured refusal. WO-466 deliberately does NOT supply this: the
   *  split has to be proven by the SAME bar the caller's whole-corridor tier just refused
   *  on, or a new tier would be a relaxation wearing a new name. The finish-lap site passes
   *  WO-449's zero-belief-uncut area test; the roughing-link site passes rung (b)(4)'s
   *  windowed traverse cap. Each keeps its own; neither moves. */
  travelClear: (a: Pt, b: Pt) => string | null
  /** The caller's own CUTTING-load proof for the engaged tail, same convention. */
  feedClear: (a: Pt, b: Pt) => string | null
  /** How much of the approach may be fed: the engine's tier-0 cut-through chord bar. */
  feedLenCap: number
}): StopShortKeepDown | { refused: string } {
  const { source, target, arcTol, gouges, travelClear, feedClear, feedLenCap } = args
  const chordLen = Math.hypot(target.x - source.x, target.y - source.y)
  if (!(chordLen > 1e-9)) return { refused: 'degenerate chord' }
  if (gouges(source, target)) {
    return { refused: `gouge -- the tool centre leaves the machinable region between (${source.x.toFixed(2)}, ${source.y.toFixed(2)}) and (${target.x.toFixed(2)}, ${target.y.toFixed(2)}), so no part of this chord is takeable` }
  }
  const at = (s: number): Pt => ({
    x: source.x + (target.x - source.x) * (s / chordLen),
    y: source.y + (target.y - source.y) * (s / chordLen),
  })
  // A whole chord that already travels clean belongs to the CHEAPER whole-corridor rung, not
  // to this one. Reaching here with a clean chord would mean a rung above was skipped.
  if (!travelClear(source, target)) {
    return { refused: 'whole chord already travels clean -- a cheaper rung owns it' }
  }
  // THE TIER-0 LENGTH CEILING, APPLIED EXACTLY AS THE ENGINE'S OWN CUT-THROUGH GATE APPLIES
  // IT. `feedLenCap` IS that gate's bar -- phase 2b admits a cut-through on
  // `chordLen <= 2 * stepOverDistance` and nothing wider -- so the comparison here is that
  // same one, with NO tolerance added on either side. (WO-466 FIX ROUND, audit finding: this
  // read `!(chordLen - feedLenCap > arcTol)`, which accepted every chord in
  // `(feedLenCap, feedLenCap + arcTol]` and fed it WHOLE while its own reason string called
  // it "inside the bar". `feedClear` measures LOAD only and reapplies no length ceiling, so
  // that arcTol was a live relaxation of a landed bar -- the one thing this helper's header
  // promises it never makes. It is gone; the bar is the bar.)
  if (chordLen <= feedLenCap) {
    // THE WHOLE CHORD IS ALREADY SHORTER THAN A CUT-THROUGH. There is no travel half to
    // prove and none is wanted: WO-453's re-seam put the lap's seam where the tool stands
    // (measured 0.05-0.07mm on six of the nine gt fixtures), so what a retract buys here is
    // a flight to clearance and back down onto the SAME SPOT. Feed it instead -- under the
    // caller's own load proof and the gouge veto already applied to the whole chord above,
    // which are the two bars the engine's tier-0 cut-through is held to, at the same length
    // bar. It is a FEED move, so WO-449's zero-tolerance rule -- which binds moves at
    // TRAVERSE speed -- is untouched: nothing here travels at traverse speed at all.
    const wholeRefusal = feedClear(source, target)
    if (wholeRefusal) {
      return { refused: `the whole ${chordLen.toFixed(2)}mm chord (inside the ${feedLenCap.toFixed(2)}mm cut-through length bar) is not takeable at feed: ${wholeRefusal}` }
    }
    return {
      travel: [source],
      feed: [source, target],
      reason: `stop-short(whole-chord)@(${target.x.toFixed(2)}, ${target.y.toFixed(2)}): the ${chordLen.toFixed(2)}mm chord is inside the ${feedLenCap.toFixed(2)}mm cut-through length bar, so NOTHING travels at traverse speed -- the whole approach is FED, load-proven and gouge-free`,
    }
  }
  // THE EARLIEST LEGAL SPLIT: any earlier and the engaged tail is longer than a cut-through
  // is ever allowed to be. Strictly positive by the branch above. Measure that one FIRST --
  // if the standing material starts further back than a cut-through's length, no split
  // exists and the retract is the honest answer.
  const sMin = chordLen - feedLenCap
  const minRefusal = travelClear(source, at(sMin))
  if (minRefusal) {
    return { refused: `the travel half cannot even reach the last ${feedLenCap.toFixed(2)}mm of the ${chordLen.toFixed(2)}mm chord: ${minRefusal}` }
  }
  // Push the split as FAR as the proof allows -- longest travel, shortest feed. The proof is
  // MONOTONE in s (a shorter prefix's swept corridor is contained in a longer one's), so a
  // bisection between a measured-clean lo and a measured-refusing hi converges on the
  // boundary, and the value kept is always one that was MEASURED clean, never interpolated.
  let lo = sMin
  let hi = chordLen
  for (let i = 0; i < 8 && hi - lo > Math.max(arcTol, AP.sampling.searchResolutionFloorMm); i++) {
    const mid = (lo + hi) / 2
    if (travelClear(source, at(mid))) hi = mid
    else lo = mid
  }
  const s = lo
  // A TRAVEL HALF UNDER THE GEOMETRY TOLERANCE IS NOT A TRAVEL. It can only arise on a chord
  // barely longer than the cut-through length bar whose proof clears almost none of it: the
  // "split" would then be the whole chord fed in all but name, and the whole chord is longer
  // than `feedLenCap` allows. Refuse, and the retract stays -- the honest answer, and the
  // same one the branch above gives to everything over the bar.
  if (!(s > arcTol)) {
    return { refused: `the travel half proves clean for only ${s.toFixed(3)}mm of the ${chordLen.toFixed(2)}mm chord -- under the ${arcTol.toFixed(3)}mm arc tolerance, so the split degenerates into feeding the whole chord, which is longer than the ${feedLenCap.toFixed(2)}mm cut-through length bar allows` }
  }
  const split = at(s)
  const feedLen = chordLen - s
  const feedRefusal = feedClear(split, target)
  if (feedRefusal) {
    return { refused: `the ${feedLen.toFixed(2)}mm engaged tail is not takeable at feed: ${feedRefusal}` }
  }
  return {
    travel: [source, split],
    feed: [split, target],
    reason: `stop-short@(${split.x.toFixed(2)}, ${split.y.toFixed(2)}): ${s.toFixed(2)}mm of the ${chordLen.toFixed(2)}mm chord travelled AT DEPTH (proved clean by the caller's own travel-speed bar), then ${feedLen.toFixed(2)}mm FED into the standing skin (<= the ${feedLenCap.toFixed(2)}mm cut-through length bar, load-proven)`,
  }
}

/** LIFT-LANDING GATE cap: max fraction of the tool-radius disk at a lift's landing point
 *  that may be UNCUT when the plunge executes. Chosen at 5% because it sits just ABOVE the
 *  engagement walker's own engage-band bite bound (maxBite = 1.5*optimal*(stepover/4+tol),
 *  ~3-4% of the tool disk on the production settings) -- so any landing as safe as a plain
 *  walker-point landing passes by construction (measured walker landings: <= 0.2% uncut,
 *  25x margin) -- while the measured cusp-ride failures (23% BootL, 97% Bar full-width
 *  center plunge) are rejected with >= 4.6x margin. */
const LANDING_UNCUT_CAP = AP.caps.landingUncutCap
/** WO-437 tier 2 (GOOD-SPEC.md section 3): the micro-lift hover height above a level's
 *  floor, in mm. WHY 2.0: the ancestor's own keep-down default (FreeCAD GenerateGCode.py
 *  jumpType-1 rapid at passEndDepth + Lift Distance) and the machinist norm of a 2-5mm
 *  hover between same-pocket passes (cutting-forces.md sec 7, machinist-consensus.md) sit
 *  either side of it. This is a WORKING ASSUMPTION -- GOOD-SPEC section 7 Q2 -- Operator rules
 *  on it at the WO-432 picture gate; it buys ZERO tolerance to uncut stock (the corridor
 *  proof below is the SAME full-width clear test tier 1 uses, never loosened for height). */
export const LIFT_DISTANCE = AP.caps.liftDistanceMm
/** WO-438 tier 1 DETOUR BUDGET (GOOD-SPEC.md section 3, "a keep-down route much longer than
 *  the direct distance is worse than the lift it avoids"). The ancestor gates the same thing
 *  with its user-facing `keepToolDownDistRatio` -- "Max length of keep tool down path compared
 *  to direct distance between points" -- and rejects an otherwise fully-clear keep-down route
 *  whose `totalLength > keepToolDownDistRatio * directDistance` [FREECAD Adaptive.cpp:2904].
 *  Its own internal floor for that ratio is 3.0 (the ResolveLinkPath time budget clamps with
 *  `max(keepToolDownDistRatio, 3.0)`, Adaptive.cpp:2791), which is the reference this port
 *  adopts. WORKING ASSUMPTION -- [OPERATOR TO RULE] at the WO-432 picture gate; it is a QUALITY
 *  bound (how much floor travel is worth avoiding one retract), never a safety allowance: a
 *  route inside this budget still has to pass the same full-width clearance proof every other
 *  tier-1 rung passes. */
export const KEEP_TOOL_DOWN_DIST_RATIO = AP.caps.keepToolDownDistRatio
/** A side (outside-in) RESEED must descend with the whole cutter in proven-cleared
 *  air: at most this fraction of the tool disk at its clear point may be uncut
 *  (numerical slack for the offset ring's arc sampling only, never a bite). */
const SIDE_RESEED_CLEAR_UNCUT_MAX = AP.caps.sideReseedClearUncutMax
/** Below this entry-ride length (mm) a shrunk cusp ride scrubs no meaningful wall sliver --
 *  drop the relocation entirely instead and land at the walker's safe point. */
const MIN_LANDING_RIDE_LEN = AP.caps.minLandingRideLenMm

/** Fraction of the tool-radius disk at `p` that is UNCUT in `cleared`. emit plunges straight
 *  down at a jumpType-2 link's landing point, so this disk is exactly the material that
 *  plunge bites (a full-width center plunge reads ~1.0). Deterministic pure geometry. */
function landingDiskUncutFraction(p: Pt, cleared: Loops, toolRadius: number, arcTol: number): number {
  const disk = diskPath(p, toolRadius, arcTol)
  const diskArea = totalArea(disk)
  if (diskArea <= 0) return 0
  return totalArea(difference(disk, cleared)) / diskArea
}

/** WO-1091: the nearest tool-CENTRE positions whose whole cutter disk stands in already
 *  cleared air, taken from `cleared` ITSELF rather than from the discrete points prior
 *  motion happened to leave behind. The locus of such centres is `cleared` eroded by the
 *  tool radius -- exactly the ring getEngagePoint builds for its roll-in
 *  (engagePoint.ts:98) -- so the candidates are the closest points of that eroded boundary
 *  to `target`, nearest first. Eroded by an extra arcTol so a candidate sitting on the
 *  eroded boundary still clears the real cleared edge by a margin the offset's arc
 *  sampling cannot eat; the caller still proves each one with landingDiskUncutFraction.
 *  Near-duplicates are thinned (consecutive edges of a dense offset polyline project to
 *  essentially the same point) so the budget spans real alternatives, not one spot.
 *  PURE + DETERMINISTIC (D-006): fixed loop/vertex iteration order, order-broken ties. */
function nearestClearAirCentres(
  target: Pt,
  cleared: Loops,
  toolRadius: number,
  arcTol: number,
  limit: number,
): Pt[] {
  const locus = offsetClosed(cleared, -(toolRadius + arcTol), arcTol)
  if (locus.length === 0) return []
  const found: Array<{ point: Pt; distance2: number; order: number }> = []
  let order = 0
  for (const loop of locus) {
    for (let index = 0; index < loop.length; index++) {
      const a = loop[index]
      const b = loop[(index + 1) % loop.length]
      const abx = b.x - a.x
      const aby = b.y - a.y
      const l2 = abx * abx + aby * aby
      let t = l2 > 1e-12 ? ((target.x - a.x) * abx + (target.y - a.y) * aby) / l2 : 0
      t = Math.max(0, Math.min(1, t))
      const point = { x: a.x + abx * t, y: a.y + aby * t }
      const dx = point.x - target.x
      const dy = point.y - target.y
      found.push({ point, distance2: dx * dx + dy * dy, order: order++ })
    }
  }
  found.sort((a, b) => a.distance2 - b.distance2 || a.order - b.order)
  const spacing = Math.max(arcTol, toolRadius * AP.sampling.clearAirSpacingToolRadii)
  const out: Pt[] = []
  for (const { point } of found) {
    if (out.some((p) => Math.hypot(p.x - point.x, p.y - point.y) < spacing)) continue
    out.push(point)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Build a circular XY lead from a proven-clear landing into `end`, tangent to
 * the first segment of the next adaptive cut. The signed-radius construction
 * selects the unique circle through `start` and `end` with the requested end
 * tangent. Long/looping arcs are rejected so the caller can try another clear
 * landing or fall back to a helix only when no lateral route is legal.
 */
function buildTangentLandingLead(
  start: Pt,
  end: Pt,
  next: Pt,
  maxChord: number,
): Pt[] | null {
  const dx = start.x - end.x
  const dy = start.y - end.y
  const distance = Math.hypot(dx, dy)
  if (distance <= 1e-9) return [start, end]

  const tx0 = next.x - end.x
  const ty0 = next.y - end.y
  const tangentLength = Math.hypot(tx0, ty0)
  if (tangentLength <= 1e-9) return null
  const tx = tx0 / tangentLength
  const ty = ty0 / tangentLength
  const nx = -ty
  const ny = tx
  const normalProjection = dx * nx + dy * ny

  // A collinear approach is already tangent and needs no curvature.
  if (Math.abs(normalProjection) <= 1e-9) {
    const approachDot = ((end.x - start.x) * tx + (end.y - start.y) * ty) / distance
    return approachDot >= 0.999 ? [start, end] : null
  }

  const signedRadius = (distance * distance) / (2 * normalProjection)
  const radius = Math.abs(signedRadius)
  if (!Number.isFinite(radius) || radius <= 1e-6) return null
  const center = {
    x: end.x + signedRadius * nx,
    y: end.y + signedRadius * ny,
  }
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x)
  let endAngle = Math.atan2(end.y - center.y, end.x - center.x)
  if (signedRadius > 0) {
    while (endAngle <= startAngle) endAngle += 2 * Math.PI
  } else {
    while (endAngle >= startAngle) endAngle -= 2 * Math.PI
  }
  const sweep = endAngle - startAngle
  if (Math.abs(sweep) > Math.PI + 1e-6) return null
  const segments = Math.ceil((radius * Math.abs(sweep)) / Math.max(maxChord, AP.sampling.chordFloorMm))
  if (segments < 1 || segments > AP.sampling.maxArcSegments) return null

  const points: Pt[] = [start]
  for (let index = 1; index < segments; index++) {
    const angle = startAngle + sweep * index / segments
    points.push({
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    })
  }
  points.push(end)
  return points
}

/**
 * Build a sampled quadratic XY lead whose endpoint is tangent to the next cut.
 * This covers convex/cusped seams where the unique circle through the clear
 * shaft and seam lies outside the machinable region. The caller still proves
 * every segment against the cut region and the sustained-engagement cap.
 */
function buildTangentLandingCurve(
  start: Pt,
  end: Pt,
  next: Pt,
  handleLength: number,
  maxChord: number,
): Pt[] | null {
  const tx0 = next.x - end.x
  const ty0 = next.y - end.y
  const tangentLength = Math.hypot(tx0, ty0)
  const distance = Math.hypot(end.x - start.x, end.y - start.y)
  if (tangentLength <= 1e-9 || distance <= 1e-9 || handleLength <= 1e-9) return null
  const tx = tx0 / tangentLength
  const ty = ty0 / tangentLength
  const control = {
    x: end.x - tx * handleLength,
    y: end.y - ty * handleLength,
  }
  const estimate = Math.hypot(control.x - start.x, control.y - start.y) + handleLength
  const segments = Math.ceil(estimate / Math.max(maxChord, AP.sampling.chordFloorMm))
  if (segments < 2 || segments > AP.sampling.maxArcSegments) return null
  const points: Pt[] = [start]
  for (let index = 1; index < segments; index++) {
    const t = index / segments
    const u = 1 - t
    points.push({
      x: u * u * start.x + 2 * u * t * control.x + t * t * end.x,
      y: u * u * start.y + 2 * u * t * control.y + t * t * end.y,
    })
  }
  points.push(end)
  return points
}

interface CornerFilletLead {
  points: Pt[]
  cutStart: Pt
}

/** Build a straight-plus-circular-fillet lead around the seam corner. */
function buildCornerFilletLead(
  clearPoint: Pt,
  corner: Pt,
  next: Pt,
  requestedRadius: number,
  maxChord: number,
): CornerFilletLead | null {
  const inDx = corner.x - clearPoint.x
  const inDy = corner.y - clearPoint.y
  const outDx = next.x - corner.x
  const outDy = next.y - corner.y
  const inLength = Math.hypot(inDx, inDy)
  const outLength = Math.hypot(outDx, outDy)
  if (inLength <= 1e-9 || outLength <= 1e-9 || requestedRadius <= 1e-9) return null
  const ux = inDx / inLength
  const uy = inDy / inLength
  const vx = outDx / outLength
  const vy = outDy / outLength
  const dot = Math.max(-1, Math.min(1, ux * vx + uy * vy))
  const theta = Math.acos(dot)
  const turn = ux * vy - uy * vx
  if (theta <= 1e-3 || theta >= Math.PI - 1e-3 || Math.abs(turn) <= 1e-6) return null
  const tangentFactor = Math.tan(theta / 2)
  if (!Number.isFinite(tangentFactor) || tangentFactor <= 1e-9) return null
  const maxRadius = Math.min(inLength * 0.8, outLength * 0.8) / tangentFactor
  const radius = Math.min(requestedRadius, maxRadius)
  if (!Number.isFinite(radius) || radius <= 1e-4) return null
  const tangentDistance = radius * tangentFactor
  const a = { x: corner.x - ux * tangentDistance, y: corner.y - uy * tangentDistance }
  const b = { x: corner.x + vx * tangentDistance, y: corner.y + vy * tangentDistance }
  const sign = turn > 0 ? 1 : -1
  const center = {
    x: a.x - sign * uy * radius,
    y: a.y + sign * ux * radius,
  }
  if (Math.abs(Math.hypot(b.x - center.x, b.y - center.y) - radius) > 1e-4) return null
  const startAngle = Math.atan2(a.y - center.y, a.x - center.x)
  let endAngle = Math.atan2(b.y - center.y, b.x - center.x)
  if (sign > 0) {
    while (endAngle <= startAngle) endAngle += 2 * Math.PI
  } else {
    while (endAngle >= startAngle) endAngle -= 2 * Math.PI
  }
  const sweep = endAngle - startAngle
  if (Math.abs(sweep) > Math.PI + 1e-6) return null
  const segments = Math.ceil(radius * Math.abs(sweep) / Math.max(maxChord, AP.sampling.chordFloorMm))
  if (segments < 1 || segments > AP.sampling.maxArcSegments) return null
  const points: Pt[] = [clearPoint]
  if (Math.hypot(a.x - clearPoint.x, a.y - clearPoint.y) > 1e-9) points.push(a)
  for (let index = 1; index < segments; index++) {
    const angle = startAngle + sweep * index / segments
    points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) })
  }
  points.push(b)
  return { points, cutStart: b }
}

/** Thrown by the lift-landing gate when a region has NO safe re-entry from the current pass end:
 *  the landing disk is uncut beyond the cap, no proven-clear shaft plus bounded lead exists, and
 *  no helix fits. processFeature catches it and ends THAT REGION with stats.aborted =
 *  'unsafe-re-entry' (WO-097 partial-region accounting) instead of failing the whole operation
 *  (WO-400). Never a silent plunge: the pass is not appended. */
export class UnsafeReentryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeReentryError'
  }
}

/** Helix floor radius (mm), the ONE source for planner and both emitters: below this a
 *  "helix" degenerates into a wobbling plunge, so the planner never labels one 'helix'
 *  (makeEntry), never offers one as a descent (planHelixDescent), and emit's default
 *  minHelixRadius reads this same constant so the two cannot drift. */
export const MIN_DESCENT_HELIX_RADIUS = AP.helix.minDescentRadiusMm
/** emit's helix rides its tool-centre circle HELIX_EDGE_BACKOFF (0.01mm) INSIDE the nominal
 *  radius, so the fit check may credit exactly that backoff against the wall clearance. */
const HELIX_FIT_EPS = AP.helix.fitEpsMm

/** Plan a HELIX DESCENT for an UNSAFE lift landing (the 472eb61 lift-landing gate's known
 *  remaining hole): early in the job the raw engagement-walker landing itself can sit in
 *  near-solid stock (measured: Bar first transition 87.8% uncut, BootL 42.6%), and the only
 *  prior remedy was a loud warn over a straight full-width plunge (R1/R2 violation). A helix
 *  ramp is the engine's sanctioned way INTO uncut material (low axial load per rev), so plan
 *  one AT the landing -- Operator's approved direction 2026-06-12.
 *
 *  Geometry rules (all constructive, no measurement needed at emit time):
 *  - radius rh <= toolRadius: the helix tool-centre circle (radius rh) sweeps the annulus
 *    [rh - toolRadius, rh + toolRadius]; with rh <= toolRadius the inner edge reaches the
 *    centre, so the helix opens its FULL disk (radius rh + toolRadius) -- no uncut core post.
 *  - the tool-centre circle must fit inside the machinable cut region: centre inside, and
 *    wall clearance >= rh (minus emit's edge backoff). The landing is normally ON the
 *    cutRegion boundary (a walker point), so the centre is shifted inward by EXACTLY rh
 *    along the local boundary normal (both normal senses tried, deterministic order). Then
 *    |centre - landing| = rh, which makes the short at-depth lead from the helix bottom to
 *    the landing lie INSIDE the just-opened disk: every lead point is within toolRadius of
 *    the segment, whose farthest point from the centre is the landing at rh, so the swept
 *    capsule stays within rh + toolRadius of the centre = the opened disk. The lead can
 *    therefore never bite beyond what the helix itself opened (R2 holds by construction).
 *  - if the modal radius does not fit, halve it (down to the emit floor) before giving up;
 *    on null the caller falls back to the existing warned straight plunge (nothing silent).
 *  Deterministic pure geometry: no RNG, no time, no global state. */
function planHelixDescent(landing: Pt, cutRegion: Loops, cutTree: PolyNode[], helixRadius: number, toolRadius: number): { center: Pt; radius: number } | null {
  const rhMax = Math.min(helixRadius, toolRadius)
  const fits = (center: Pt, rh: number): boolean =>
    !isOutsideCutRegion(center, cutTree) && distToLoops(center, cutRegion) >= rh - HELIX_FIT_EPS
  // Local boundary normal at the landing (projection is radius-independent; compute once).
  const proj = projectOnLoops(landing, cutRegion)
  let normal: Pt | null = null
  if (proj.loop >= 0) {
    const lp = cutRegion[proj.loop]
    const a = lp[proj.seg], b = lp[(proj.seg + 1) % lp.length]
    const ex = b.x - a.x, ey = b.y - a.y
    const L = Math.hypot(ex, ey)
    if (L > 1e-9) normal = { x: -ey / L, y: ex / L }
  }
  // (c) a landing ON A CORNER of the region (two walls meet at the walker point) has no
  //     clearance along EITHER wall's normal: shifting by rh along one normal slides along
  //     the other wall. The nearest fitting centre is along the corner's inward bisector at
  //     rh * sqrt(2). Fixed 8-direction fan, deterministic order, so any corner angle finds
  //     the sense that opens up. The at-depth lead then runs rh * sqrt(2) instead of rh, so
  //     it can reach (sqrt(2) - 1) * rh <= 0.42 * helixRadius past the disk the helix opened
  //     -- a bounded side bite, well under one stepover, taken as a feed 'ramp' move.
  const fan: Pt[] = []
  for (let k = 0; k < 8; k++) {
    const a = (Math.PI / 4) * k
    fan.push({ x: Math.cos(a), y: Math.sin(a) })
  }
  for (let rh = rhMax; rh >= MIN_DESCENT_HELIX_RADIUS; rh /= 2) {
    // (a) the landing already has rh of wall clearance -> helix centred AT the landing (no lead).
    if (fits(landing, rh)) return { center: landing, radius: rh }
    // (b) shift the centre inward off the wall by exactly rh (try both normal senses; the
    //     inward one passes the inside-region check, the outward one fails it).
    if (normal) {
      for (const s of [1, -1]) {
        const center = { x: landing.x + s * normal.x * rh, y: landing.y + s * normal.y * rh }
        if (fits(center, rh)) return { center, radius: rh }
      }
    }
  }
  // (c) only after the whole (a)/(b) ladder failed, so every landing the ladder served before
  //     keeps its exact helix (byte-stable), and the corner fan is purely additive.
  for (let rh = rhMax; rh >= MIN_DESCENT_HELIX_RADIUS; rh /= 2) {
    const d = rh * Math.SQRT2
    for (const dir of fan) {
      const center = { x: landing.x + dir.x * d, y: landing.y + dir.y * d }
      if (fits(center, rh)) return { center, radius: rh }
    }
  }
  return null
}

function polylineLength(pts: Pt[]): number {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return s
}

// ---- WO-447 WALL-COVERAGE BOOKKEEPING (arc-length parameterization of a cutRegion loop) ----
//
// A wall-follow ride is, BY CONSTRUCTION, a sub-polyline of ONE cutRegion boundary loop
// (wallCleanLoop.ts's contract, and boundaryArcsBetween's). So "which stretches of the wall
// has the roughing already ridden" is answerable exactly, with no new geometry: give each
// loop its arc-length coordinate, project each ride onto it, and merge the intervals. The
// complement is the coverage GAP -- the stretches WO-446 measured standing against the wall,
// which are a coverage gap in the as-we-go cleanup and not a stepover remainder.

/** Cumulative arc length at each vertex of a closed loop, plus its perimeter. */
interface LoopArcTable { per: number; cum: number[] }

function buildLoopArcTable(lp: Loop): LoopArcTable {
  const cum: number[] = new Array(lp.length)
  let s = 0
  for (let i = 0; i < lp.length; i++) {
    cum[i] = s
    const a = lp[i], b = lp[(i + 1) % lp.length]
    s += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return { per: s, cum }
}

// WO-3024: wallRouteKeepsDirection rebuilt every loop's table on every call (38 s inclusive on
// the Form cylinder). A loop is never mutated once built, so its table is built once.
const loopArcTables = new WeakMap<Loop, LoopArcTable>()
function cachedLoopArcTable(lp: Loop): LoopArcTable {
  const cached = loopArcTables.get(lp)
  if (cached && cached.cum.length === lp.length) return cached
  const table = buildLoopArcTable(lp)
  loopArcTables.set(lp, table)
  return table
}

/** Arc coordinate (in [0, per)) of a point that projects onto segment `seg` at `foot`. */
function arcCoordOf(lp: Loop, table: LoopArcTable, seg: number, foot: Pt): number {
  if (table.per <= 0) return 0
  const s = table.cum[seg] + Math.hypot(foot.x - lp[seg].x, foot.y - lp[seg].y)
  return ((s % table.per) + table.per) % table.per
}

/** Record [a -> b) walked FORWARD along the loop, splitting a seam-crossing span in two so
 *  every recorded span is flat (a <= b) and mergeable by ordinary interval merging. */
function addCoveredSpan(spans: [number, number][], a: number, b: number, per: number): void {
  if (b >= a) { if (b > a) spans.push([a, b]) }
  else { spans.push([a, per]); spans.push([0, b]) }
}

/** WO-447 coverage credit, factored out (WO-2787 round 7): project one wall ride onto
 *  `cutRegion` and record, per loop, the arc spans it genuinely rode. The gap-fill reads the
 *  whole stream through it; the reposition time model reads a candidate through it. */
function creditWallRide(covered: [number, number][][], pts: Pt[], cutRegion: Loops, arcTables: LoopArcTable[], proofTol: number, arcTol: number): void {
  let prev = projectOnLoops(pts[0], cutRegion)
  for (let i = 1; i < pts.length; i++) {
    const cur = projectOnLoops(pts[i], cutRegion)
    const li = prev.loop
    // Same loop, both ends genuinely ON the wall, loop has length: otherwise the step
    // is not evidence that this stretch was ridden and the span stays UNCOVERED --
    // the conservative direction (an uncovered span is re-examined, never assumed).
    if (li >= 0 && cur.loop === li && prev.dist <= proofTol && cur.dist <= proofTol && arcTables[li].per > 0) {
      const lp = cutRegion[li], table = arcTables[li]
      const s0 = arcCoordOf(lp, table, prev.seg, prev.foot)
      const s1 = arcCoordOf(lp, table, cur.seg, cur.foot)
      const fwd = ((s1 - s0) % table.per + table.per) % table.per
      const span = Math.min(fwd, table.per - fwd)
      // DID THIS STEP ACTUALLY RIDE THE WALL BETWEEN THESE TWO POINTS? A genuine wall
      // ride is a SUB-POLYLINE of the loop, so consecutive ride points sit on one facet
      // or on adjacent vertices and the arc between them EQUALS the straight step, to
      // within the projection tolerance. A step whose endpoints are both near the wall
      // but whose arc is far longer than the step did NOT ride that arc -- it cut the
      // corner, or crossed the field. Crediting it would mark material covered that the
      // tool never touched, which is the one error this bookkeeping must never make.
      // Such a step contributes NOTHING and the arc stays a gap, to be re-examined.
      const chord = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
      const rodeTheArc = span <= chord + 2 * proofTol + 2 * arcTol
      // Consecutive ride points are ADJACENT on the loop, so the span they cover is
      // the SHORT way round; taking the long way would credit a whole perimeter to a
      // single step. Ties (exactly half a perimeter) take the forward sense.
      if (rodeTheArc && fwd <= table.per - fwd) addCoveredSpan(covered[li], s0, s1, table.per)
      else if (rodeTheArc) addCoveredSpan(covered[li], s1, s0, table.per)
    }
    prev = cur
  }
}

/** Merged total of flat spans (mm). */
function mergedSpanLength(spans: [number, number][]): number {
  const merged = mergeSpans(spans)
  let s = 0
  for (const [a, b] of merged) s += b - a
  return s
}

function mergeSpans(spans: [number, number][]): [number, number][] {
  if (spans.length === 0) return []
  const sorted = [...spans].sort((p, q) => p[0] - q[0])
  const merged: [number, number][] = [[sorted[0][0], sorted[0][1]]]
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]
    if (sorted[i][0] <= last[1]) last[1] = Math.max(last[1], sorted[i][1])
    else merged.push([sorted[i][0], sorted[i][1]])
  }
  return merged
}

/** The COMPLEMENT of the covered spans on one closed loop: each gap as { start, len },
 *  walked FORWARD from `start` (the seam gap is returned as ONE wrapping span, never two,
 *  so a gap straddling arc coordinate 0 is ridden as one continuous move). */
function uncoveredSpans(spans: [number, number][], per: number): { start: number; len: number }[] {
  if (per <= 0) return []
  const merged = mergeSpans(spans)
  if (merged.length === 0) return [{ start: 0, len: per }]
  const gaps: { start: number; len: number }[] = []
  for (let i = 0; i + 1 < merged.length; i++) {
    const len = merged[i + 1][0] - merged[i][1]
    if (len > 0) gaps.push({ start: merged[i][1], len })
  }
  const wrapLen = merged[0][0] + (per - merged[merged.length - 1][1])
  if (wrapLen > 0) gaps.push({ start: merged[merged.length - 1][1], len: wrapLen })
  return gaps
}

/** The point at arc coordinate `s` on a closed loop, with the segment it sits on. */
function pointAtArc(lp: Loop, table: LoopArcTable, s: number): { pt: Pt; seg: number } {
  const per = table.per
  const t = per > 0 ? ((s % per) + per) % per : 0
  let seg = 0
  for (let i = 0; i < lp.length; i++) { if (table.cum[i] <= t) seg = i; else break }
  const a = lp[seg], b = lp[(seg + 1) % lp.length]
  const segLen = Math.hypot(b.x - a.x, b.y - a.y)
  const f = segLen > 1e-12 ? Math.min(1, Math.max(0, (t - table.cum[seg]) / segLen)) : 0
  return { pt: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, seg }
}

/** Walk `lp` FORWARD from arc coordinate `start` for `len` mm. The result is a TRUE
 *  sub-polyline of the loop (every interior point is a loop vertex, the two ends are on
 *  loop edges), so it is on the boundary by construction and can never leave the region,
 *  cross a hole, or jump loops -- the same guarantee buildWallFollowExit/Entry carry. */
function spanPolyline(lp: Loop, table: LoopArcTable, start: number, len: number): Pt[] {
  const n = lp.length
  const s0 = pointAtArc(lp, table, start)
  const out: Pt[] = [s0.pt]
  let remaining = len
  let seg = s0.seg
  let cur = s0.pt
  let guard = 0
  while (remaining > 1e-9 && guard++ < 4 * n + 8) {
    const v = lp[(seg + 1) % n]
    const d = Math.hypot(v.x - cur.x, v.y - cur.y)
    if (d <= remaining + 1e-12) {
      if (d > 1e-12) out.push(v)
      remaining -= d
      cur = v
      seg = (seg + 1) % n
    } else {
      const f = remaining / d
      out.push({ x: cur.x + (v.x - cur.x) * f, y: cur.y + (v.y - cur.y) * f })
      remaining = 0
    }
  }
  return out
}

/** Union the corridor swept by a polyline (open-round offset by toolRadius) into cleared. */
function expandCleared(cleared: Loops, path: Pt[], toolRadius: number, arcTol: number): Loops {
  if (path.length < 2) return cleared
  // WO-410: only real travel sweeps material. A pass whose stepper never moved leaves
  // toClearPath = [p, p] (the engage point twice: the boundary-clipped zero-area step is
  // pushed before the area test breaks the pass), and the open-round offset of a
  // zero-length polyline is a FULL CUTTER DISK -- 71 mm^2 of phantom "cleared" at an
  // engage point the tool never cut (nothing is emitted for such a pass). Measured on
  // Full_Suite "3D Rough 2" (z -2.5): 110 such stalls in one level, 13.7 mm^2 the emitted
  // path never swept; the keep-down links through it passed every material test at 40%
  // while the live stock stood at 81%, and reseed declared lobes "complete" that held a
  // cutter's width of real material. Fold NOTHING unless the path holds two DISTINCT
  // points; termination without the fiction is the walker's fruitless-lap contract (see
  // the pass loop), not phantom belief.
  const travelled: Pt[] = [path[0]]
  for (let i = 1; i < path.length; i++) {
    const last = travelled[travelled.length - 1]
    if (Math.hypot(path[i].x - last.x, path[i].y - last.y) > 1e-9) travelled.push(path[i])
  }
  if (travelled.length < 2) return cleared
  // Swept corridor = open-round offset of the WHOLE polyline in one clipper call, then
  // one union into cleared. (Previously an O(N) chain of per-segment capsule unions --
  // the dominant non-steering cost; see perf notes.)
  const corridor = offsetOpenRound(travelled, toolRadius, arcTol)
  if (corridor.length === 0) return cleared
  return union(cleared, corridor)
}

/** Append a cut pass, prefixed by a link move whose jumpType records whether the jump
 *  from the previous pass end stays inside cleared (keep down) or not (lift), and -- for
 *  the first pass of a region -- the helix/plunge `entry`. Order: link -> entry -> cut.
 *  Returns the (possibly updated) `cleared` belief: a WO-436 tier-0 cut-through sweeps
 *  real material outside the caller's own toClearPath fold, so the caller must adopt the
 *  return value the same way it already folds its own pass geometry.
 *
 *  WO-447 adds two OPTIONAL trailing parameters, both defaulted to today's behaviour so
 *  every existing call site is byte-identical:
 *   - `passType`: the role the appended pass carries. 'cut' (default) is unchanged; a
 *     wall-coverage gap ride passes 'wallfollow' because it IS a wall ride, not a new
 *     roughing pass -- it must not inflate the cut-pass count nor be offered to later
 *     connections as proven-cleared waypoints (collectPriorMotion deliberately takes CUT
 *     points only, because a wall ride's full-width corridor reaches INTO the wall).
 *   - `prevMotion`: where the tool PHYSICALLY IS when this pass starts, when that is not
 *     the end of the last 'cut' pass. Needed exactly because a 'wallfollow' pass is not a
 *     'cut': without it, a second gap ride would gate its connection from a stale point.
 *     Null (default) keeps the historical `lastCut(passes)` behaviour. */
/** WO-449: the lift-landing gate's context, made explicit so the SAME gate serves both an
 *  ordinary jumpType-2 pass landing (appendCutPass) and a wall-finish connection's descent
 *  (the wallFinish block). Every field is what the closure used to capture; nothing about
 *  the gate's ladder, caps or order changed when it moved to module scope. */
/** Exported (WO-1178 item 0) so the routed landing rung has its own fixture:
 *  wo1178-routed-landing-bound.test.ts drives planGatedLanding with a hand-built stock state
 *  that reaches the all-gouge rung by construction. Nothing in the product builds one. */
export interface LandingGateContext {
  /** Live pass stream -- the constructive evidence of already-swept ground. */
  passes: AdaptivePass[]
  /** PHYSICAL pre-move stock state (GOOD-SPEC section 4 clearedBeforePass discipline). */
  clearedBeforePass: Loops
  /** Tool-centre region the descent and its lead must stay inside. For a roughing landing
   *  this is the roughing cutRegion; for a wall-finish connection it is the TRUE-WALL
   *  tool-centre region (the finish contour rides finishStock closer to the wall than
   *  cutRegion reaches, so gating it against cutRegion would reject every legal lead). */
  cutRegion: Loops
  cutTree: PolyNode[]
  toolRadius: number
  helixRadius: number
  stepOverDistance: number
  arcTol: number
  landingUncutCap: number
  millingDirection: AdaptiveMillingDirection
  /** The pass this landing feeds; the re-seam rung walks its first samples. */
  points: Pt[]
  boundarySpan: Pt[] | null
  /** Whether the re-seam rung may move the seam forward on `points`. */
  allowReseam: boolean
  /** Where the gate's fail-loud lines go; console.warn when absent. WO-2787 round 7: the
   *  reposition time model plans the lift before it is chosen, and holds these lines until
   *  that lift is actually emitted. */
  warn?: (message: string) => void
  onAcceptedGraphRoute?: AcceptedGraphRouteObserver
}

interface ClearedLandingApproach {
  /** Optional fed disengage from the cut frontier until the whole cutter reaches clear stock. */
  departure?: Pt[]
  /** Full-width, zero-belief-uncut travel at depth. */
  travel: Pt[]
  /** Fed tail from the first material contact to the requested landing. */
  lead: Pt[]
  family: 'backtrack' | 'detour' | 'via-cleared'
}

function splitDepartureToClearStock(
  route: Pt[],
  clearedBeforePass: Loops,
  toolRadius: number,
  arcTol: number,
  family: ClearedLandingApproach['family'],
): Pick<ClearedLandingApproach, 'departure' | 'travel'> | null {
  if (route.length < 2) return null
  if (wholeCutterRouteIsClear(route, clearedBeforePass, toolRadius, arcTol)) {
    return { travel: route }
  }
  const reversed = splitClearedLandingApproach(
    [...route].reverse(), clearedBeforePass, toolRadius, arcTol, family,
  )
  if (!reversed) return null
  const departure = [...reversed.lead].reverse()
  const travel = [...reversed.travel].reverse()
  if (departure.length < 2 || travel.length < 2) return null
  return { departure, travel }
}

function wholeCutterRouteIsClear(
  route: Pt[],
  clearedBeforePass: Loops,
  toolRadius: number,
  arcTol: number,
): boolean {
  if (route.length < 2) return true
  // The cutter already occupies the source disk at depth. Crediting that disk is physical
  // state, not predicted clearing: the route cannot newly touch stock underneath the tool
  // before it starts moving.
  const travelCleared = union(clearedBeforePass, diskPath(route[0], toolRadius, arcTol))
  const corridor = offsetOpenRound(route, toolRadius, arcTol)
  return totalArea(difference(corridor, travelCleared)) <= TRAVEL_BELIEF_UNCUT_EPS
}

/** Split a routed landing approach at the first point where its whole-cutter corridor stops
 * being proven clear. The prefix is safe at traverse speed; the remainder is the bounded,
 * fed engage. Returning null is conservative: a keep-down landing is offered only when it
 * contains a real cleared-stock traverse and a real engaged tail. */
function splitClearedLandingApproach(
  route: Pt[],
  clearedBeforePass: Loops,
  toolRadius: number,
  arcTol: number,
  family: ClearedLandingApproach['family'],
): ClearedLandingApproach | null {
  if (route.length < 2) return null
  const clear = (path: Pt[]): boolean => {
    return wholeCutterRouteIsClear(path, clearedBeforePass, toolRadius, arcTol)
  }
  const travel: Pt[] = [route[0]]
  for (let index = 1; index < route.length; index++) {
    const previous = route[index - 1]
    const endpoint = route[index]
    if (clear([...travel, endpoint])) {
      travel.push(endpoint)
      continue
    }

    // The clear-prefix predicate is monotone along this segment. Keep only a point that was
    // itself measured clear; never interpolate the final split without rechecking it.
    let lo = 0
    let hi = 1
    let split = previous
    for (let attempt = 0; attempt < 12 && hi - lo > 1e-5; attempt++) {
      const t = (lo + hi) / 2
      const candidate = {
        x: previous.x + (endpoint.x - previous.x) * t,
        y: previous.y + (endpoint.y - previous.y) * t,
      }
      if (clear([...travel, candidate])) { lo = t; split = candidate } else hi = t
    }
    if (Math.hypot(split.x - travel[travel.length - 1].x, split.y - travel[travel.length - 1].y) > 1e-6) {
      travel.push(split)
    }
    if (polylineLength(travel) <= Math.max(arcTol, 0.01)) return null
    const lead = dedupConsecutive([travel[travel.length - 1], endpoint, ...route.slice(index + 1)], Math.max(arcTol, 1e-6))
    if (lead.length < 2 || polylineLength(lead) <= Math.max(arcTol, 0.01)) return null
    return { travel, lead, family }
  }
  return null
}

export function planGatedLanding(g: LandingGateContext, source: Pt, landing: Pt, nextCutPoint: Pt): {
  landing: Pt
  helix?: { center: Pt; radius: number }
  lead?: Pt[]
  cutStartIndex?: number
  /** WO-1091: the returned `landing` came from the clear-air rung and is proven to the side
   *  entry's own bound (whole cutter in air). The caller stamps it on the link so emit
   *  descends the shaft as a RAPID and runs the lead at leadInRate. Never set on a rung whose
   *  shaft was proven only to the looser landingUncutCap. */
  clearAirLanding?: true
  /** WO-1138: no descent at all. Travel through proven-cleared stock at depth, then feed the
   * bounded terminal engage where material begins. */
  keepDownApproach?: ClearedLandingApproach
} {
  const {
    passes, clearedBeforePass, cutRegion, cutTree, toolRadius, helixRadius, stepOverDistance,
    arcTol, landingUncutCap, millingDirection, points, boundarySpan, allowReseam,
  } = g
  const warn = g.warn ?? ((message: string): void => console.warn(message))
  const frac = landingDiskUncutFraction(landing, clearedBeforePass, toolRadius, arcTol)
  if (frac <= landingUncutCap) return { landing }

  // First choice: descend through a cutter-diameter shaft that prior
  // motion has proven clear, then arc into the next cut horizontally.
  // This avoids a redundant helix through air beside known-clear stock.
  const leadCap = AP.caps.rideCapStepovers * stepOverDistance
  const tangentArcStarts: Pt[] = []

  // Prefer compact, conventional tangent leads immediately behind the next cut. A clear
  // shaft and the start of the arc are allowed to differ later, but these quarter/partial
  // arc starts cover the common case without extra reposition motion.
  const tangentDx = nextCutPoint.x - landing.x
  const tangentDy = nextCutPoint.y - landing.y
  const tangentLength = Math.hypot(tangentDx, tangentDy)
  if (tangentLength > 1e-9) {
    const tx = tangentDx / tangentLength
    const ty = tangentDy / tangentLength
    const nx = -ty
    const ny = tx
    const radii = [
      Math.max(arcTol * 4, stepOverDistance * 0.25),
      Math.max(arcTol * 4, stepOverDistance * 0.5),
      Math.max(arcTol * 4, stepOverDistance),
      Math.max(arcTol * 4, toolRadius),
      Math.max(arcTol * 4, toolRadius * 1.5),
    ]
    for (const radius of radii) {
      for (const sweep of [Math.PI / 6, Math.PI / 4, Math.PI / 3, Math.PI / 2]) {
        for (const sign of [1, -1]) {
          const endRx = -sign * radius * nx
          const endRy = -sign * radius * ny
          const c = Math.cos(-sign * sweep)
          const s = Math.sin(-sign * sweep)
          const startRx = endRx * c - endRy * s
          const startRy = endRx * s + endRy * c
          const arcStart = {
            x: landing.x + sign * radius * nx + startRx,
            y: landing.y + sign * radius * ny + startRy,
          }
          tangentArcStarts.push(arcStart)
        }
      }
    }
  }

  // The nearest clear shaft is often beside the rejected straight connection rather
  // than on it. Search previously emitted cutter-centre motion as constructive evidence:
  // every accepted point was already swept by the cutter before this pass. Rank by
  // distance so the resulting lateral reposition stays short and deterministic.
  const priorMotion: Array<{ point: Pt; distance2: number; order: number }> = []
  let order = 0
  const addPriorPoint = (point: Pt): void => {
    const dx = point.x - landing.x
    const dy = point.y - landing.y
    priorMotion.push({ point, distance2: dx * dx + dy * dy, order: order++ })
  }
  for (const pass of passes) {
    if (pass.type === 'cut' || pass.type === 'lead' || pass.type === 'wallfollow' || pass.type === 'loopback' || pass.type === 'finish') {
      for (const point of pass.points) addPriorPoint(point)
    } else if (pass.type === 'entry') {
      addPriorPoint(pass.clearPoint ?? pass.point)
    }
  }
  priorMotion.sort((a, b) => a.distance2 - b.distance2 || a.order - b.order)
  const provenShaftCandidates = [source, ...priorMotion.slice(0, 96).map((prior) => prior.point)]

  for (const candidate of provenShaftCandidates) {
    if (landingDiskUncutFraction(candidate, clearedBeforePass, toolRadius, arcTol) > landingUncutCap) continue
    const lead = buildTangentLandingLead(candidate, landing, nextCutPoint, arcTol * 4)
    if (!lead) continue
    let exitsRegion = false
    for (let index = 1; index < lead.length; index++) {
      if (centrePathExitsCutRegion(lead[index - 1], lead[index], cutTree, toolRadius)) {
        exitsRegion = true
        break
      }
    }
    if (exitsRegion) continue
    if (rideOverloadsUncut(lead, clearedBeforePass, toolRadius, leadCap, arcTol)) continue
    warn(
      `[lift-landing] landing disk at (${landing.x.toFixed(2)}, ${landing.y.toFixed(2)}) is `
      + `${(frac * 100).toFixed(1)}% uncut > cap ${(landingUncutCap * 100).toFixed(0)}% -- `
      + `descending at proven-cleared (${candidate.x.toFixed(2)}, ${candidate.y.toFixed(2)}) then using a `
      + `${polylineLength(lead).toFixed(2)}mm tangent XY lead`,
    )
    return { landing: candidate, lead }
  }

  // A valid clear shaft does not have to coincide with the arc start. For a standard
  // line-plus-arc lead, walk backward from each legal tangent arc along its first chord
  // until a fully cleared cutter disk is found. The straight leg and sampled arc share
  // one direction at their join, so the emitted XY motion has no reversal or sharp corner.
  const clearSearchStep = Math.max(arcTol * 4, stepOverDistance * 0.25)
  const clearSearchLimit = Math.max(toolRadius * 4, stepOverDistance * 4)
  for (const arcStart of tangentArcStarts) {
    const arc = buildTangentLandingLead(arcStart, landing, nextCutPoint, arcTol * 4)
    if (!arc || arc.length < 2) continue
    const firstDx = arc[1].x - arc[0].x
    const firstDy = arc[1].y - arc[0].y
    const firstLength = Math.hypot(firstDx, firstDy)
    if (firstLength <= 1e-9) continue
    const ux = firstDx / firstLength
    const uy = firstDy / firstLength
    for (const clearPoint of provenShaftCandidates) {
      const offsetDx = clearPoint.x - arcStart.x
      const offsetDy = clearPoint.y - arcStart.y
      const along = offsetDx * ux + offsetDy * uy
      const across = Math.abs(offsetDx * uy - offsetDy * ux)
      if (along >= -clearSearchStep || -along > clearSearchLimit || across > clearSearchStep) continue
      if (landingDiskUncutFraction(clearPoint, clearedBeforePass, toolRadius, arcTol) > landingUncutCap) continue
      const lead = [clearPoint, ...arc]
      let exitsRegion = false
      for (let index = 1; index < lead.length; index++) {
        if (centrePathExitsCutRegion(lead[index - 1], lead[index], cutTree, toolRadius)) {
          exitsRegion = true
          break
        }
      }
      if (exitsRegion) continue
      if (rideOverloadsUncut(lead, clearedBeforePass, toolRadius, leadCap, arcTol)) continue
      warn(
        `[lift-landing] landing disk at (${landing.x.toFixed(2)}, ${landing.y.toFixed(2)}) is `
        + `${(frac * 100).toFixed(1)}% uncut > cap ${(landingUncutCap * 100).toFixed(0)}% -- `
        + `descending at proven-cleared (${clearPoint.x.toFixed(2)}, ${clearPoint.y.toFixed(2)}) then using a `
        + `${polylineLength(lead).toFixed(2)}mm tangent line-arc XY lead`,
      )
      return { landing: clearPoint, lead }
    }
  }


  // At a convex or cusped pass seam, no single circular arc through the clear shaft may
  // remain inside cutRegion. Keep the same endpoint and tangent, but allow a smooth
  // quadratic lead to bend around the retained boundary. This is still horizontal-only
  // motion and is accepted only after the same full path and engagement proofs.
  for (const candidate of provenShaftCandidates) {
    if (landingDiskUncutFraction(candidate, clearedBeforePass, toolRadius, arcTol) > landingUncutCap) continue
    const distance = Math.hypot(landing.x - candidate.x, landing.y - candidate.y)
    const handles = [
      Math.max(arcTol * 4, distance * 0.2),
      Math.max(arcTol * 4, distance * 0.35),
      Math.max(arcTol * 4, distance * 0.5),
      Math.max(arcTol * 4, distance * 0.75),
      Math.max(arcTol * 4, stepOverDistance),
    ]
    for (const handle of handles) {
      const lead = buildTangentLandingCurve(candidate, landing, nextCutPoint, handle, arcTol * 4)
      if (!lead) continue
      let exitsRegion = false
      for (let index = 1; index < lead.length; index++) {
        if (centrePathExitsCutRegion(lead[index - 1], lead[index], cutTree, toolRadius)) {
          exitsRegion = true
          break
        }
      }
      if (exitsRegion) continue
      if (rideOverloadsUncut(lead, clearedBeforePass, toolRadius, leadCap, arcTol)) continue
      warn(
        `[lift-landing] landing disk at (${landing.x.toFixed(2)}, ${landing.y.toFixed(2)}) is `
        + `${(frac * 100).toFixed(1)}% uncut > cap ${(landingUncutCap * 100).toFixed(0)}% -- `
        + `descending at proven-cleared (${candidate.x.toFixed(2)}, ${candidate.y.toFixed(2)}) then using a `
        + `${polylineLength(lead).toFixed(2)}mm tangent curved XY lead`,
      )
      return { landing: candidate, lead }
    }
  }

  // Standard CAM lead at a hard seam: approach on a straight line, trim the first cut
  // segment, and join both with a true tangent circular fillet. Unlike a circle forced
  // through the clear shaft, this lets the shaft sit anywhere along the incoming tangent.
  for (const candidate of provenShaftCandidates) {
    if (landingDiskUncutFraction(candidate, clearedBeforePass, toolRadius, arcTol) > landingUncutCap) continue
    for (const radius of [toolRadius * 0.5, stepOverDistance, stepOverDistance * 0.5, stepOverDistance * 0.25]) {
      const fillet = buildCornerFilletLead(candidate, landing, nextCutPoint, radius, arcTol * 4)
      if (!fillet) continue
      let exitsRegion = false
      for (let index = 1; index < fillet.points.length; index++) {
        if (centrePathExitsCutRegion(fillet.points[index - 1], fillet.points[index], cutTree, toolRadius)) {
          exitsRegion = true
          break
        }
      }
      if (exitsRegion) continue
      if (rideOverloadsUncut(fillet.points, clearedBeforePass, toolRadius, leadCap, arcTol)) continue
      const skipped = offsetOpenRound([landing, fillet.cutStart], toolRadius, arcTol)
      const leadSweep = offsetOpenRound(fillet.points, toolRadius, arcTol)
      const available = leadSweep.length > 0 ? union(clearedBeforePass, leadSweep) : clearedBeforePass
      const missing = difference(skipped, available)
      if (maxInscribedRadius(missing, toolRadius, Math.max(arcTol, 0.01)) > arcTol) continue
      warn(
        `[lift-landing] landing disk at (${landing.x.toFixed(2)}, ${landing.y.toFixed(2)}) is `
        + `${(frac * 100).toFixed(1)}% uncut > cap ${(landingUncutCap * 100).toFixed(0)}% -- descending at `
        + `proven-cleared (${candidate.x.toFixed(2)}, ${candidate.y.toFixed(2)}) then using a `
        + `${polylineLength(fillet.points).toFixed(2)}mm tangent line-and-fillet XY lead`,
      )
      return { landing: candidate, lead: fillet.points, cutStartIndex: 1 }
    }
  }

  // If the fixed seam is a convex cusp that cannot accept any legal tangent curve,
  // move the seam forward a few samples on the same pass. This is permitted only when
  // the new lead plus already-cleared stock covers the complete skipped cutter corridor,
  // so re-seaming cannot leave a sliver or spire behind.
  const leadIsLegal = (lead: Pt[]): boolean => {
    for (let index = 1; index < lead.length; index++) {
      if (centrePathExitsCutRegion(lead[index - 1], lead[index], cutTree, toolRadius)) return false
    }
    return !rideOverloadsUncut(lead, clearedBeforePass, toolRadius, leadCap, arcTol)
  }
  const leadCoversSkippedPrefix = (lead: Pt[], cutStartIndex: number): boolean => {
    const prefix = points.slice(0, cutStartIndex + 1)
    const required = offsetOpenRound(prefix, toolRadius, arcTol)
    if (required.length === 0) return true
    const leadSweep = offsetOpenRound(lead, toolRadius, arcTol)
    const available = leadSweep.length > 0 ? union(clearedBeforePass, leadSweep) : clearedBeforePass
    return totalArea(difference(required, available)) <= Math.max(1e-6, arcTol * arcTol * 4)
  }
  // WO-449: a CLOSED finish contour may never be re-seamed -- its prefix is part of the
  // lap, not a skippable head -- so finish connections switch this rung off (allowReseam
  // false makes the loop below run zero times). Every pre-WO-449 caller passes true.
  const maxReseamIndex = allowReseam ? Math.min(points.length - 2, 8) : 0
  for (let cutStartIndex = 1; cutStartIndex <= maxReseamIndex; cutStartIndex++) {
    const target = points[cutStartIndex]
    const next = points[cutStartIndex + 1]
    const rankedClearCandidates = provenShaftCandidates
      .map((candidate, candidateOrder) => ({
        candidate,
        candidateOrder,
        distance2: (candidate.x - target.x) ** 2 + (candidate.y - target.y) ** 2,
      }))
      .sort((a, b) => a.distance2 - b.distance2 || a.candidateOrder - b.candidateOrder)
      .slice(0, 16)
    for (const { candidate } of rankedClearCandidates) {
      if (landingDiskUncutFraction(candidate, clearedBeforePass, toolRadius, arcTol) > landingUncutCap) continue
      const distance = Math.hypot(target.x - candidate.x, target.y - candidate.y)
      const leads: Pt[][] = []
      const circular = buildTangentLandingLead(candidate, target, next, arcTol * 4)
      if (circular) leads.push(circular)
      for (const handleFactor of [0.2, 0.35, 0.5, 0.75, 1]) {
        const curve = buildTangentLandingCurve(
          candidate,
          target,
          next,
          Math.max(arcTol * 4, distance * handleFactor),
          arcTol * 4,
        )
        if (curve) leads.push(curve)
      }
      for (const lead of leads) {
        if (!leadIsLegal(lead) || !leadCoversSkippedPrefix(lead, cutStartIndex)) continue
        warn(
          `[lift-landing] fixed seam at (${landing.x.toFixed(2)}, ${landing.y.toFixed(2)}) cannot accept a legal `
          + `clear-shaft tangent lead -- re-seamed ${cutStartIndex} samples forward to `
          + `(${target.x.toFixed(2)}, ${target.y.toFixed(2)}), descending at proven-cleared `
          + `(${candidate.x.toFixed(2)}, ${candidate.y.toFixed(2)}) and covering the skipped prefix with a `
          + `${polylineLength(lead).toFixed(2)}mm tangent XY lead`,
        )
        return { landing: candidate, lead, cutStartIndex }
      }
    }
  }

  // The engagement walker may already have supplied the exact boundary
  // span leading into this cut. When the fixed seam cannot accept a generic
  // tangent, descend at the earliest clear point on that same span and ride
  // it horizontally into the cut. The direction gate is mandatory: a
  // reposition may never turn this into an implicit both-ways move.
  if (boundarySpan && boundarySpan.length >= 2
    && wallPointsMatchDirection(boundarySpan, cutRegion, millingDirection)) {
    for (let startIndex = 0; startIndex < boundarySpan.length - 1; startIndex++) {
      const candidate = boundarySpan[startIndex]
      if (landingDiskUncutFraction(candidate, clearedBeforePass, toolRadius, arcTol) > landingUncutCap) continue
      const lead = boundarySpan.slice(startIndex)
      let exitsRegion = false
      for (let index = 1; index < lead.length; index++) {
        if (centrePathExitsCutRegion(lead[index - 1], lead[index], cutTree, toolRadius)) {
          exitsRegion = true
          break
        }
      }
      if (exitsRegion || rideOverloadsUncut(lead, clearedBeforePass, toolRadius, leadCap, arcTol)) continue
      warn(
        `[lift-landing] fixed seam at (${landing.x.toFixed(2)}, ${landing.y.toFixed(2)}) cannot accept a legal `
        + `generic tangent lead -- descending at proven-cleared (${candidate.x.toFixed(2)}, `
        + `${candidate.y.toFixed(2)}) and following the direction-correct recovered boundary span`,
      )
      return { landing: candidate, lead }
    }
  }

  // WO-1091: LAND IN THE CLEARED AIR BESIDE THE TARGET AND LEAD IN.
  //
  // Every rung above searched for a clear shaft among the DISCRETE points prior motion
  // happened to leave behind. That set is blind to the cleared air a cutter CENTRE never
  // entered: the open stock exterior the side entry rolls in from, or a lane one stepover
  // to the side. A landing beside such air is not an island of stock and has no business
  // being drilled -- it lands out in the air with the whole cutter clear, then LEADS IN,
  // the same standard reposition a side entry already makes (emit.ts:288-303 is that
  // emitted shape: rapid over the clear point, rapid down through air, feed in). Operator,
  // 2026-08-28: "why are we helixing instead of putting the entry as a straight plunge into
  // cleared space next to the desired entry position, and performing a step over/lead-in
  // into the desired reentry point... if the space is cleared the reentry has no risk."
  //
  // THE DESCENT POINT is taken from `cleared` ITSELF -- eroded by the tool radius, exactly
  // the ring getEngagePoint builds for its roll-in (engagePoint.ts:98) -- and held to the
  // SIDE ENTRY'S OWN proof, landingDiskUncutFraction <= SIDE_RESEED_CLEAR_UNCUT_MAX (the
  // whole cutter in air), not the looser landingUncutCap this gate's shafts use. So the
  // plunge itself is through air, with zero uncut stock under it. That is the half of this
  // rung that carries the safety, and it is the strictest proof in the gate.
  //
  // THE LEAD is Operator's "step over/lead-in", so it is capped like the engine's other at-depth
  // stepover motion: 0.75 of a full slot at FULL tool width against the physical
  // clearedBeforePass -- the SAME keep-down honesty bound WO-410 set on a link ("a stepover
  // link legitimately rides the cut frontier engaging up to ~one tool RADIUS of the next
  // lane"). NOT the 1.5x-stepover ride cap the rungs above use: that cap is the right number
  // for a lead that merely repositions over ground ALREADY SWEPT, and this is the move that
  // OPENS the re-entry -- the same class of motion as a keep-down link across the frontier,
  // and it is measured the same way, at full width, against the same physical stock. No cap
  // in this gate is loosened, and no rung above changes: this one is only ever reached where
  // the alternative was a helix boring a (helixRadius + toolRadius) hole through solid stock.
  //
  // FIRST FIT, in the same order every rung above uses: candidates nearest-first, and within
  // a candidate the lead ladder shortest-handle-first. The ladder now runs to a 3x handle
  // because the peak bite of a lead into a buried seam falls as the approach gets SHALLOWER
  // (measured on Bar: 3.59 mm2/mm at a 2.30mm reposition, 3.17 at 3.61mm, 2.96 once the
  // approach flattens) -- so the shallow end of the ladder is what makes this rung legal
  // under the existing cap rather than a looser one.
  const sideLandingCap = AP.caps.slotCeilingDiameters * (2 * toolRadius)
  // WO-1091 (audit round 2): the rung COUNTS what it rejected, so the helix warn below can
  // name WHICH of the two cases kept the helix -- no cleared air reaches this landing (the
  // island of stock the helix was always for), or cleared air stands right beside it but
  // every lead out of it would leave cutRegion and gouge the finish wall. Those are
  // different remainders, and the second one cannot be closed by loosening this gate.
  // Diagnostic only: no motion depends on these counters.
  let airCandidates = 0
  let leadsGouged = 0
  let leadsOverloaded = 0
  // WO-1178 item 0: routed keep-down leads the configured-engagement bound refused, so the
  // helix warn below can say which bound kept the helix.
  let routedLeadsRefused = 0
  let routedRefusal = ''
  const clearAirCentres = nearestClearAirCentres(landing, clearedBeforePass, toolRadius, arcTol, 24)
  for (const candidate of clearAirCentres) {
    if (landingDiskUncutFraction(candidate, clearedBeforePass, toolRadius, arcTol) > SIDE_RESEED_CLEAR_UNCUT_MAX) continue
    airCandidates++
    const distance = Math.hypot(landing.x - candidate.x, landing.y - candidate.y)
    const leads: Pt[][] = []
    const circular = buildTangentLandingLead(candidate, landing, nextCutPoint, arcTol * 4)
    if (circular) leads.push(circular)
    for (const handleFactor of [0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3]) {
      const curve = buildTangentLandingCurve(
        candidate,
        landing,
        nextCutPoint,
        Math.max(arcTol * 4, distance * handleFactor),
        arcTol * 4,
      )
      if (curve) leads.push(curve)
    }
    for (const lead of leads) {
      let exitsRegion = false
      for (let index = 1; index < lead.length; index++) {
        if (centrePathExitsCutRegion(lead[index - 1], lead[index], cutTree, toolRadius)) {
          exitsRegion = true
          break
        }
      }
      if (exitsRegion) { leadsGouged++; continue }
      const load = contourOverCap(lead, clearedBeforePass, toolRadius, sideLandingCap, arcTol)
      if (load.overLen > 0) { leadsOverloaded++; continue }
      warn(
        `[lift-landing] landing disk at (${landing.x.toFixed(2)}, ${landing.y.toFixed(2)}) is `
        + `${(frac * 100).toFixed(1)}% uncut > cap ${(landingUncutCap * 100).toFixed(0)}% -- landing in the CLEARED AIR `
        + `beside it at (${candidate.x.toFixed(2)}, ${candidate.y.toFixed(2)}) (whole cutter proven clear) and leading `
        + `in over a ${polylineLength(lead).toFixed(2)}mm lead peaking at ${load.peak.toFixed(2)}mm2/mm <= `
        + `${sideLandingCap.toFixed(2)} cap, instead of drilling a helix (WO-1091)`,
      )
      return { landing: candidate, lead, clearAirLanding: true }
    }
  }

  // WO-1138: REACH THE LANDING THROUGH CLEARED STOCK INSTEAD OF DRILLING THE AIR BESIDE IT.
  // A tight corner may reject every bounded tangent shape even though the cutter's own swept
  // tracks connect the current position to the requested seam. Reuse the routed keep-down
  // planner's finish-wall veto and detour budget. Its route is then split at first material
  // contact: the prefix is held to T5's zero-belief-uncut full-cutter proof and emitted as a
  // traverse; only the tail is fed, under the 0.75-slot ceiling and, for the all-gouge case
  // below, the operation's configured radial engagement (WO-1141B / WO-1178 item 0).
  //
  // A tangent's gouge refusal applies to that tangent only. Every routed departure, traverse
  // and lead below independently takes the same cutRegion veto, so a different wall-following
  // shape may be legal without bypassing the finish-wall verdict; requiring an overloaded
  // tangent here stranded Tee despite 24 whole-cutter-clear candidates (WO-1141B). An
  // all-gouge result still carries less evidence than an overload result -- no tangent showed
  // a legal material-side corridor -- so in that case the routed lead must enter at the
  // operation's configured stepover, and that bound is enforced on the MEASURED bite: the
  // windowed peak with the short-circuit sentinel bypassed AND the largest sub-step bite,
  // which no longer ride can dilute (the audited attempt met the window by padding it with a
  // zero-removal out-and-back). No staged nibble, no padding: the lead is the direct chord or
  // a routed keep-down path, and if neither measures under the bound the helix stays and the
  // console names the bound that refused it.
  const direct = Math.hypot(landing.x - source.x, landing.y - source.y)
  if (direct > 1e-9 && airCandidates > 0) {
    const routedLandingCap = leadsOverloaded > 0
      ? sideLandingCap
      : Math.min(sideLandingCap, stepOverDistance)
    const underRoutedCap = (lead: Pt[]): { overLen: number; peak: number; at: Pt; maxStep: number } | null => {
      const load = contourOverCap(lead, clearedBeforePass, toolRadius, routedLandingCap, arcTol, true)
      return load.overLen <= 0 && load.maxStep <= routedLandingCap + 1e-9 ? load : null
    }
    const priorCut = lastCut(passes)
    const priorMotion: Pt[] = []
    for (const pass of passes) {
      if (pass.type === 'cut') priorMotion.push(...pass.points)
      else if (pass.type === 'entry') priorMotion.push(pass.clearPoint ?? pass.point)
    }
    const wallTol = Math.max(arcTol * AP.sampling.wallTolArcTols, toolRadius * AP.sampling.wallTolToolRadii)
    const graph = buildClearedTrackGraph(passes, toolRadius, stepOverDistance, cutTree, wallTol)
    const budget = KEEP_TOOL_DOWN_DIST_RATIO * direct

    // Prefer an explicit two-stage construction: a zero-uncut traverse to a whole-cutter-clear
    // point, followed by a bounded fed route from that point to the seam. This is the wall-follow
    // shape the tangent-only rung cannot express in a tight corner.
    for (const clearPoint of clearAirCentres) {
      if (landingDiskUncutFraction(clearPoint, clearedBeforePass, toolRadius, arcTol) > SIDE_RESEED_CLEAR_UNCUT_MAX) continue
      let departureAndTravel: Pick<ClearedLandingApproach, 'departure' | 'travel'> | null = null
      const directTravel = [source, clearPoint]
      if (routeEscapingSegment(directTravel, cutTree, toolRadius, wallTol) < 0
        && contourOverCap(directTravel, clearedBeforePass, toolRadius, sideLandingCap, arcTol).overLen <= 0) {
        departureAndTravel = splitDepartureToClearStock(
          directTravel, clearedBeforePass, toolRadius, arcTol, 'via-cleared',
        )
      } else {
        const routedTravel = planKeepDownRoute(
          source, clearPoint, priorCut?.points ?? null, priorMotion, graph, clearedBeforePass,
          cutTree, toolRadius, stepOverDistance, arcTol, sideLandingCap, budget, null, g.onAcceptedGraphRoute,
        )
        if (routedTravel) {
          departureAndTravel = splitDepartureToClearStock(
            routedTravel.points, clearedBeforePass, toolRadius, arcTol, routedTravel.family,
          )
        }
      }
      if (!departureAndTravel) continue
      const { departure, travel } = departureAndTravel
      const travelLength = polylineLength(travel)
      const departureLength = departure ? polylineLength(departure) : 0
      const remainingBudget = budget - travelLength - departureLength
      if (remainingBudget <= Math.max(arcTol, 0.01)) continue

      let lead: Pt[] | null = null
      const directLead = [clearPoint, landing]
      // WO-1178 fix round 3: a direct chord that stays in the region but measures over the
      // bound is a REFUSED lead and is counted as one, so the helix line below names the
      // bound that kept the helix (the trigger's own requirement) instead of reading
      // "0 exceeded the engage cap" when the configured engagement was what refused it.
      let directRefused = false
      if (routeEscapingSegment(directLead, cutTree, toolRadius, wallTol) < 0) {
        if (underRoutedCap(directLead)) lead = directLead
        else directRefused = true
      }
      let family: ClearedLandingApproach['family'] = 'via-cleared'
      if (!lead) {
        const routedLead = planKeepDownRoute(
          clearPoint, landing, null, priorMotion, graph, clearedBeforePass, cutTree, toolRadius,
          stepOverDistance, arcTol, routedLandingCap, remainingBudget, null, g.onAcceptedGraphRoute,
        )
        if (routedLead) { lead = routedLead.points; family = routedLead.family }
      }
      if (!lead) { if (directRefused) routedLeadsRefused++; continue }
      const load = underRoutedCap(lead)
      if (!load) { routedLeadsRefused++; continue }
      const approach = { ...(departure ? { departure } : {}), travel, lead, family } satisfies ClearedLandingApproach
      warn(
        `[lift-landing] no legal tangent lead reaches (${landing.x.toFixed(2)}, ${landing.y.toFixed(2)}) after `
        + `${airCandidates} whole-cutter-clear candidate(s) (${leadsGouged} gouged, ${leadsOverloaded} overloaded) -- `
        + `STAYING DOWN via ${family}: ${departureLength.toFixed(2)}mm fed disengage, ${travelLength.toFixed(2)}mm `
        + `traverse through whole-cutter-clear stock `
        + `to (${clearPoint.x.toFixed(2)}, ${clearPoint.y.toFixed(2)}), then ${polylineLength(lead).toFixed(2)}mm `
        + `fed engage measuring ${load.peak.toFixed(2)}mm2/mm over the window and ${load.maxStep.toFixed(2)}mm2/mm `
        + `at its deepest sub-step, both <= the ${routedLandingCap.toFixed(2)}mm2/mm `
        + `${leadsOverloaded > 0 ? '0.75-slot ceiling' : 'configured radial engagement'} (WO-1138 / WO-1178)`,
      )
      return { landing, keepDownApproach: approach }
    }
    if (routedLeadsRefused > 0) {
      routedRefusal = `${routedLeadsRefused} routed keep-down lead(s) measured over the `
        + `${routedLandingCap.toFixed(2)}mm2/mm ${leadsOverloaded > 0 ? '0.75-slot ceiling' : 'configured radial engagement'} on the window or at a sub-step`
    }
  }

  // No legal clear-shaft plus lateral route exists. Only now may the
  // planner open new material with a helix.
  const hd = planHelixDescent(landing, cutRegion, cutTree, helixRadius, toolRadius)
  if (hd) {
    const airVerdict = airCandidates === 0
      ? 'NO cleared air stands the whole cutter beside it (an island of stock -- what the helix is for)'
      : `${airCandidates} whole-cutter-clear point(s) DO stand beside it, but every lead out of them failed: `
        + `${leadsGouged} left cutRegion (would gouge the finish wall) and ${leadsOverloaded} exceeded the `
        + `${sideLandingCap.toFixed(2)}mm engage cap${routedRefusal ? `; ${routedRefusal}` : ''}`
    warn(`[lift-landing] landing disk at (${landing.x.toFixed(2)}, ${landing.y.toFixed(2)}) is ${(frac * 100).toFixed(1)}% uncut > cap ${(landingUncutCap * 100).toFixed(0)}% and no verified clear-shaft tangent lead fits -- ${airVerdict} -- descending via HELIX at (${hd.center.x.toFixed(2)}, ${hd.center.y.toFixed(2)}) r=${hd.radius.toFixed(2)}mm`)
    return { landing, helix: hd }
  }
  throw new UnsafeReentryError(
    `[lift-landing] unsafe re-entry refused at (${landing.x.toFixed(2)}, ${landing.y.toFixed(2)}): `
    + `${(frac * 100).toFixed(1)}% of the landing disk is uncut, no proven-cleared bounded `
    + 'lead exists, and no helix fits (ADR-0003)',
  )
}

function appendCutPass(passes: AdaptivePass[], points: Pt[], cleared: Loops, clearedBeforePass: Loops, cutTree: PolyNode[], cutRegion: Loops, toolRadius: number, helixRadius: number, stepOverDistance: number, arcTol: number, optimal: number, entry: AdaptiveEntry | null, boundarySpan: Pt[] | null = null, integralWallFollow = false, integralWallFollowLengthFactor = 2, wallCleanupAsWeGo = false, loopbackFilletPct = 25, millingDirection: AdaptiveMillingDirection = 'climb', landingUncutCap = LANDING_UNCUT_CAP, directionFallback?: WallCleanupDirectionFallback, liftFallbackHelix = false, passType: 'cut' | 'wallfollow' = 'cut', prevMotion: Pt[] | null = null, departHead = 0, exteriorAirDepthAt: ((p: Pt) => number) | null = null, strictWallLoops: Loops | null = null, ringEntry = false, repositionTime: RepositionTimeModel | null = null, onAcceptedGraphRoute?: AcceptedGraphRouteObserver): Loops {
  if (points.length < 1) return cleared
  // WO-1235: the 3D single-owner contract names the loops whose wall DIRECTION it protects:
  // the islands and bosses of the wall band it finishes. That contract only engages when the
  // retained model has no pocket outer wall, so every model wall is a HOLE of the region and
  // the region's outer loop is the stock section -- air past it, not a finished surface.
  // Direction there is meaningless, and judging it forced a retract at every reversed
  // pass-to-pass hop along the taper boss's stock edge (2 -> 12 retracts).
  const strictWallFlow = strictWallLoops !== null
  const wallLoops = strictWallLoops ? strictWallLoops.filter(loop => loopArea(loop) <= 0) : cutRegion
  // WO-400: a jumpType-2 link the gate accepted as a straight descent still gets a helix that
  // FITS at its landing, for an emitter that can prove the shaft against live carved stock.
  // Attached only on request so the default pass stream stays byte-identical.
  const attachFallbackHelix = (link: Extract<AdaptivePass, { type: 'link' }>): void => {
    if (!liftFallbackHelix || link.jumpType !== 2 || link.helixDescent) return
    const hd = planHelixDescent(link.points[1], cutRegion, cutTree, helixRadius, toolRadius)
    if (hd) link.fallbackHelix = hd
  }
  // WO-437 tier 2: a jumpType-2 link's direct corridor (its own two points, straight line --
  // exactly what emit's two horizontal-clearance rapids traverse) gets the micro-lift hop
  // ONLY when that corridor is proven clear at FULL tool width against clearedBeforePass, the
  // SAME proof (rideOverloadsUncut, cap = 1.5x stepover) tier 1's wallfollow/loopback/chord
  // rungs are held to above -- never a loosened version, per the binding mechanism constraint.
  // A corridor that fails this proof keeps today's full-clearance behavior unchanged (no
  // field attached). Legality note: this proof is presence-at-full-width, not a load
  // allowance -- micro-lift height buys zero tolerance to uncut stock (GOOD-SPEC section 3).
  const attachMicroLift = (link: Extract<AdaptivePass, { type: 'link' }>): void => {
    if (link.jumpType !== 2) return
    // ARCHITECT GUARD (WO-437 review): never micro-lift a link that lands via helix descent.
    // emitHelixRamp's first move is a rapid to the helix START point -- from a 2mm hover that
    // rapid is a rising diagonal whose XY track deviates from the proven a->b corridor by up
    // to the helix radius, i.e. travel over belief-UNPROVEN stock below rim height (T5).
    // From full clearance (today's behavior) the same approach is safe. Measured 2026-08-20:
    // the combination occurs 0 times on the nine-fixture corpus (helix landings sit exactly
    // where the corridor proof fails), so this guard is latent-only and changes no corpus
    // motion -- it exists for the geometry that WILL combine them someday.
    if (link.helixDescent) return
    const cap = AP.caps.rideCapStepovers * stepOverDistance
    if (rideOverloadsUncut(link.points, clearedBeforePass, toolRadius, cap, arcTol)) return
    // WO-3037 (switch keepDownLinksSmooth, default OFF): the hover is LIFT_DISTANCE over THIS
    // level's floor, so it clears a sliver of this level and nothing taller. A corridor that
    // meets stock the belief holds standing outside its landing bite flies at clearance.
    if (ADAPTIVE_MOTION_SWITCHES.keepDownLinksSmooth && rideMeetsStandingStock(link.points, clearedBeforePass, toolRadius, arcTol)) return
    link.microLift = { z: LIFT_DISTANCE }
    // WO-2835: the proof above tolerates slivers under its cap, which a LIFT_DISTANCE hover
    // clears wherever the stepdown is below it; a floor-setting hop (0.3 mm) would not. So the
    // hop at the setting is offered only for a corridor (landing disk included) with NO uncut
    // stock at full tool width -- the keep-down's own plowsUncut test. Non-enumerable, like
    // liftReason, so the byte-stability fingerprint of the pass stream is unchanged.
    if (totalArea(difference(offsetOpenRound(link.points, toolRadius, arcTol), clearedBeforePass)) <= 1e-6) {
      Object.defineProperty(link.microLift, 'empty', { value: true, enumerable: false })
    }
  }
  // WO-435 T1: attach liftReason NON-ENUMERABLE so it stays readable by direct property
  // access (the tripwire test) but invisible to JSON.stringify -- the byte-stability
  // fingerprint (_bytestab-fingerprint.test.ts) hashes JSON.stringify({ passes, ... }), and
  // this field must be genuinely additive to that emitted/hashed representation, not just
  // to the plan's geometry. A plain assignment measurably changed every fixture's fingerprint
  // (passes count unchanged, hash changed) even though motion did not; this keeps it additive.
  const setLiftReason = (link: Extract<AdaptivePass, { type: 'link' }>, reason: string): void => {
    Object.defineProperty(link, 'liftReason', { value: reason, enumerable: false, configurable: true, writable: true })
  }
  // WO-438: every previously emitted cutter-centre point, as constructive evidence of cleared
  // ground for the routed keep-down rung (the SAME set and the same rationale the lift-landing
  // gate's clear-shaft search already uses). Built at most once per call, and only when a
  // connection actually reaches that rung. Subsampled with a stride so a long pass stream
  // cannot make the ranking cost grow without bound; the stride never changes WHICH ground is
  // cleared, only how finely the waypoint candidates sample it.
  let priorMotionCache: Pt[] | null = null
  const collectPriorMotion = (): Pt[] => {
    if (priorMotionCache) return priorMotionCache
    const all: Pt[] = []
    for (const pass of passes) {
      // CUT points only. `cleared` is the union of the CUT passes' swept capsules
      // (expandCleared, full tool radius) plus each entry's seed disk -- so the full-width
      // corridor around a cut point is cleared BY CONSTRUCTION. A wall-follow, lead, loopback
      // or finish point is NOT: those rides were only ever proven under the ride cap, and a
      // wall ride's full-width corridor deliberately reaches INTO the wall. Offering them as
      // "proven-cleared" waypoints would route travel through stock the belief never claimed.
      if (pass.type === 'cut') {
        for (const point of pass.points) all.push(point)
      } else if (pass.type === 'entry') {
        all.push(pass.clearPoint ?? pass.point)
      }
    }
    const MAX_SAMPLES = AP.sampling.maxPriorMotionSamples
    if (all.length <= MAX_SAMPLES) { priorMotionCache = all; return all }
    const stride = Math.ceil(all.length / MAX_SAMPLES)
    const thinned: Pt[] = []
    for (let i = 0; i < all.length; i += stride) thinned.push(all[i])
    priorMotionCache = thinned
    return thinned
  }
  // WO-438: the swept-track connectivity graph, built at most once per call and only when a
  // connection actually reaches the routed rung.
  let trackGraphCache: ClearedTrackGraph | null | undefined
  const buildTrackGraph = (): ClearedTrackGraph | null => {
    if (trackGraphCache === undefined) trackGraphCache = buildClearedTrackGraph(passes, toolRadius, stepOverDistance, cutTree, Math.max(arcTol * AP.sampling.wallTolArcTols, toolRadius * AP.sampling.wallTolToolRadii))
    return trackGraphCache
  }
  // WO-429: DOES THIS ENTRY ACTUALLY OPEN THIS CUT?
  //
  // A re-seed hands `pendingEntry` to the first pass that is KEPT. Nothing bounded how
  // long it waited. Measured on engagementPocket (roughGateA Gate A.5): a re-seed at
  // (16.719, 18.565) produced a pass that cut nothing, the engage walker then crawled
  // the frontier for 58 further zero-area passes, and the entry was finally attached to
  // a kept cut 35.2 mm away. Every emitter (2D emit.ts, cam3d rough/emit.ts) suppresses
  // the link before an entry -- "the entry owns its own safe approach" -- so that pairing
  // emitted a helix at the stale seed followed by a straight AT-DEPTH feed to the distant
  // cut start, with no gate of any kind between them. On engagementPocket that feed ran
  // from the right chamber into the left one straight THROUGH the solid x=[40,50] divider;
  // adaptiveRough's retained-model gate refused it at the first sample past the wall
  // (tip (51.9857, 46.6874, 4.0) needs Z >= 16). The gate was right; the pairing was wrong.
  //
  // THE BOUND is the seed disk the re-seed credited into `cleared`: radius
  // entry.radius + toolRadius, because the entry's helix sweeps its cutter centre round
  // the circle of radius entry.radius and so physically opens exactly that disk. A cut
  // whose first point lies inside that disk IS the opening spiral this entry exists for,
  // and the at-depth feed from the helix exit to it runs over ground the entry just
  // opened. A cut starting outside the disk is different ground the entry never opened:
  // the entry still has to run (it removes the credited seed disk -- no phantom credit),
  // but the transition from it to the cut is an ordinary connection and is gated like
  // one. Measured separation: legitimate openings sit at (gap - entry.radius) <= 0.457 mm
  // across the 2D gt corpus and the cam3d fixtures; stale ones at >= 2.35 mm.
  const staleEntry = entry !== null
    && Math.hypot(entry.point.x - points[0].x, entry.point.y - points[0].y)
      > entry.radius + toolRadius
    ? entry
    : null
  let entryEmitted = false
  if (staleEntry) {
    // Emitted HERE so the order is entry -> link -> [lead] -> cut and no emitter's
    // "skip the link immediately before an entry" rule can swallow the connection.
    passes.push({
      type: 'entry',
      point: staleEntry.point,
      ...(staleEntry.clearPoint ? { clearPoint: staleEntry.clearPoint } : {}),
      radius: staleEntry.radius,
      mode: staleEntry.mode,
    })
    entryEmitted = true
  }
  // WO-447: `prevMotion`, when supplied, IS the prior motion -- the wall ride the tool just
  // finished, which is not a 'cut' pass and so is invisible to lastCut. Everything
  // downstream (the connection's start point, the wall-follow exit construction, the routed
  // keep-down rung's backtrack track) then judges the corridor the machine actually travels,
  // exactly as it does for an ordinary cut. Absent (every pre-WO-447 call site) it is the
  // last 'cut' pass, unchanged.
  const prevCut = (prevMotion && prevMotion.length >= 2)
    ? { type: 'cut' as const, points: prevMotion }
    : lastCut(passes)
  let cutStartIndex = 0
  // The passes this call ends with: the cut, from `startIndex` (a re-seamed landing skips the
  // samples before it and starts at the end of its lead, `startPoint`). WO-1178 root cause 1,
  // DEPARTURE: the walker's curvature-limited first steps off a planted wall start are the
  // wall ride's tail (held to the cusp cap, see the walker), emitted as a 'lead' -- the fed
  // engage from the wall into the ring, at cutting feed -- so the ring starts where the fillet
  // ends. Not a 'wallfollow': that role is a sub-polyline OF the wall (its material-side and
  // on-wall invariants say so), and this tail leaves the wall by design. Only for a plain cut
  // whose start the connection above landed on as planned (no re-seam, no entry).
  // WO-447: the ONLY difference a 'wallfollow' passType makes is the role tag on this push.
  // Every gate above ran identically. Written as two literal pushes rather than a computed
  // `type` so the 'cut' object literal is character-for-character what it always was.
  // WO-2787 round 7: the reposition time model prices a lift with the same passes.
  const emittedCutPasses = (startIndex: number, startPoint: Pt | undefined): AdaptivePass[] => {
    const out: AdaptivePass[] = []
    let emittedPoints = startIndex > 0
      ? [startPoint ?? points[startIndex], ...points.slice(startIndex)]
      : points
    if (passType === 'cut' && departHead > 0 && startIndex === 0 && !entry && points.length > departHead + 1) {
      out.push({ type: 'lead', points: points.slice(0, departHead + 1) })
      emittedPoints = points.slice(departHead)
    }
    if (passType === 'wallfollow') out.push({ type: 'wallfollow', points: emittedPoints })
    else out.push({ type: 'cut', points: emittedPoints })
    return out
  }
  // The end of the last lead in `list`: where a re-seamed cut starts.
  const lastLeadEnd = (list: AdaptivePass[]): Pt | undefined => {
    for (let index = list.length - 1; index >= 0; index--) {
      const pass = list[index]
      if (pass.type !== 'lead' || pass.points.length === 0) continue
      return pass.points[pass.points.length - 1]
    }
    return undefined
  }
  if (prevCut || staleEntry) {
    // A stale entry's connection starts where the tool physically IS when it executes --
    // at the bottom of the helix just emitted -- not at the end of whatever cut preceded
    // the re-seed. Everything downstream (the keep-down/lift decision, the keep-down
    // overload cap, the lift-landing gate) then judges the corridor the machine
    // actually travels.
    const lastPoint = staleEntry ? staleEntry.point : prevCut!.points[prevCut!.points.length - 1]
    const nextPoint = points[0]

    // LIFT-LANDING SAFETY GATE. emit descends vertically at every jumpType-2 landing, so gate
    // the complete cutter disk against clearedBeforePass, the physical stock state when that
    // descent executes. If the requested landing is not clear, first find a proven-clear shaft
    // and connect horizontally with a bounded tangent lead. A helix may open new stock only
    // when no legal clear-shaft route exists. No unsafe straight-plunge fallback is permitted.
    // WO-449: the gate itself now lives at module scope (planGatedLanding) so the
    // wall-finish connection descends the SAME ladder with the SAME caps. This closure is
    // the identical call it always was -- context assembled from exactly what it captured.
    const landingGate: LandingGateContext = {
      passes, clearedBeforePass, cutRegion, cutTree, toolRadius, helixRadius, stepOverDistance,
      arcTol, landingUncutCap, millingDirection, points, boundarySpan, allowReseam: true, onAcceptedGraphRoute,
    }
    const gateLiftLanding = (source: Pt, landing: Pt, nextCutPoint: Pt) =>
      planGatedLanding(landingGate, source, landing, nextCutPoint)

    // ── TWO LAYERED FEATURES, EACH IN ITS OWN ROLE (defect fix 2026-06-09) ──────────────
    //
    // The connecting move between two cut passes is composed by two independent features that
    // layer in a fixed ORDER so neither filters the other:
    //
    //   1. CLEANUP (wallCleanupAsWeGo) = CUSP CLEANUP. Owns ONLY the arc ends. At a wall-reaching
    //      transition it adds a wall-follow EXIT ride (scrub the wall behind arc N's contact) and
    //      a wall-follow ENTRY ride (scrub the wall into arc N+1's contact). Both RIDE THE ACTUAL
    //      cutRegion LOOP POLYLINE vertex-by-vertex, so they can never leave the region, cross a
    //      hole, or jump loops. Cleanup does NOT decide keep-down-vs-lift and does NOT build the
    //      cross-gap connection -- it only moves the connection's endpoints out to the ride far
    //      ends (E, F).
    //
    //   2. RETRACT-ELIMINATION (integralWallFollow) = the SOLE keep-down-vs-lift AUTHORITY. It
    //      runs on the resulting connection (E -> F if cleanup rode the cusps, else the raw arc
    //      endpoints): ride the shared wall to stay down if safe, else LIFT. This is the existing,
    //      unchanged logic.
    //
    // When BOTH fire and the connection is itself a same-loop wall ride, the exit cusp ride, the
    // connection ride, and the entry cusp ride are CONTIGUOUS sub-polylines of the same wall, so
    // they MERGE into ONE continuous wall-follow A -> B (deduped; no wall segment ridden twice).

    // ── Phase 1: CLEANUP (cusp rides at the arc ends only) ──────────────────────────────
    // Only at a wall-reaching transition, and never on a re-seed link (that carries a fresh
    // region's plunge `entry`; there is no prior cut to scrub against). Cleanup makes NO
    // lift/keep-down decision here -- it just supplies the two rides and their far ends.
    let exitRide: WallFollowRide | null = null
    let entryRide: WallFollowRide | null = null
    // WO-1178 (Operator's Tee finding): ONE forward ride A -> B when the next cut starts a short way
    // ahead on the same wall, in place of overlapping cusp rides joined by a backward hop.
    let throughRide: WallFollowRide | null = null
    const wallTol = Math.max(arcTol * AP.sampling.wallTolArcTols, toolRadius * AP.sampling.wallTolToolRadii)
    if (wallCleanupAsWeGo && !entry) {
      wallCleanStats.transitions++
      const projPrior = projectOnLoops(lastPoint, cutRegion)
      const projNext = projectOnLoops(nextPoint, cutRegion)
      if (projPrior.dist <= wallTol && projNext.dist <= wallTol) {
        // WO-1178 ROOT CAUSE 2 (the Tee's rounded inside corner, Operator 2026-09-02). The exit
        // ride rides FORWARD from A for its budget (3 mm) and the entry ride rides BACK from B
        // for the same budget, both built blind to each other. When B stands less than the two
        // budgets ahead of A on the same wall the rides overlap, and the connection between
        // their far ends E -> F runs BACKWARD along the wall the tool has just ridden. At the
        // Tee's stem/base fillet (a 2.5 mm arc convex to the tool) every rung then refused it
        // for the right reasons -- the backward chord leaves the region (gouge), the backward
        // arc is an opposite-sense ride, the other arc is the whole loop, no routed detour is
        // in budget, stop-short gouges -- and the ladder conceded a tier-2 micro-lift of
        // 3.2 mm over ground the exit ride had cleaned a moment earlier. No tier was wrong;
        // the connection was. Ride the wall once, forward, from A to B, held to the cusp cap
        // and the milling-direction gate like every other cusp ride. Nothing else changes: the
        // cut passes, the belief and every non-overlapping transition are untouched.
        const cuspCap = AP.caps.rideCapStepovers * stepOverDistance
        const through = buildWallFollowThrough(prevCut!.points, points, cutRegion, toolRadius, undefined, loopbackFilletPct)
        if (through) {
          const thOver = rideOverloadsUncut(through.points, clearedBeforePass, toolRadius, cuspCap, arcTol)
          if (thOver) {
            console.warn(`[wall-clean] through ride REFUSED (load): sustained effective width ${thOver.width.toFixed(2)}mm > cap ${cuspCap.toFixed(2)}mm near (${thOver.at.x.toFixed(2)}, ${thOver.at.y.toFixed(2)}) -- the cusp rides are built as before (WO-1178)`)
          } else if (!wallRideMatchesDirection(through, cutRegion, millingDirection)) {
            console.warn(`[wall-clean] through ride rejected: ${millingDirection} material side would invert -- the cusp rides are built as before (WO-1178)`)
          } else {
            throughRide = through
            wallCleanStats.fired++
          }
        }
      }
      if (throughRide === null && projPrior.dist <= wallTol && projNext.dist <= wallTol) {
        const ex = buildWallFollowExit(prevCut!.points, cutRegion, toolRadius, undefined, loopbackFilletPct)
        const en = buildWallFollowEntry(points, cutRegion, toolRadius, undefined, loopbackFilletPct)
        // WO-1178: A CUSP RIDE IS A CUTTING MOVE AND IS HELD TO THE CUT'S CAP. The exit and
        // entry rides were emitted on geometry alone (a sub-polyline of the wall), on the
        // assumption that they scrub a thin wall sliver. At a pocket corner that assumption
        // fails: the entry ride into the Bar's first top-left start pivoted on the corner
        // vertex through the standing corner and read 3.46 mm2/mm -- 87% of a slot, fed at
        // wall-follow rate, with no gate anywhere. Measure both rides against the physical
        // pre-move stock at the SAME 1.5 x stepover cap every tier-1 wall ride is held to;
        // a ride over the cap is dropped, the connection is then planned between the raw cut
        // ends exactly as when cleanup does not fire, and the wall stretch it would have
        // ridden stays for the walker's own passes and the gap-fill ride, which are gated.
        const cuspCap = AP.caps.rideCapStepovers * stepOverDistance
        const exOver = ex ? rideOverloadsUncut(ex.points, clearedBeforePass, toolRadius, cuspCap, arcTol) : null
        const enOver = en ? rideOverloadsUncut(en.points, clearedBeforePass, toolRadius, cuspCap, arcTol) : null
        if (ex && en && (exOver || enOver)) {
          const over = exOver ?? enOver!
          console.warn(`[wall-clean] cusp ${exOver ? 'exit' : 'entry'} ride REFUSED (load): sustained effective width ${over.width.toFixed(2)}mm > cap ${cuspCap.toFixed(2)}mm near (${over.at.x.toFixed(2)}, ${over.at.y.toFixed(2)}) -- riding the corner would cut it at a slot's engagement; the connection is planned between the cut ends instead (WO-1178)`)
        }
        if (ex && en && !exOver && !enOver) {
          const directionOk = wallRideMatchesDirection(ex, cutRegion, millingDirection)
            && wallRideMatchesDirection(en, cutRegion, millingDirection)
          if (directionOk) {
            exitRide = ex
            entryRide = en
            wallCleanStats.fired++
          } else {
            if (directionFallback && !directionFallback.rejected) {
              console.warn(
                `[wall-clean] ${millingDirection} cusp ride rejected: material side would invert `
                + '-- deferring complete wall cleanup to the final oriented contour',
              )
            }
            if (directionFallback) directionFallback.rejected = true
          }
        }
      }
    }

    // WO-1178: the through ride IS the whole connection -- the tool rides the wall forward from
    // the prior cut's end to the next cut's start; there are no far ends to link, so the ladder
    // below is never entered (there is nothing for a tier to decide).
    let throughEmitted = false
    if (throughRide) {
      assertInsideCutRegion(throughRide.points, cutTree, wallTol, 'through wall-follow')
      passes.push({ type: 'wallfollow', points: throughRide.points })
      throughEmitted = true
    }
    if (!throughEmitted) {
    // The connection that retract-elimination must resolve runs between the cusp rides' far ends
    // (when cleanup fired) or between the raw arc endpoints (when it did not).
    const connStart = exitRide ? exitRide.far : lastPoint
    const connEnd = entryRide ? entryRide.far : nextPoint

    // WO-2787 fix round 7: THE LIFT THIS CONNECTION WOULD EMIT, planned once. A lift is not a
    // plain full-clearance link: the landing gate may move its landing, lead it in, re-seam the
    // cut forward or keep it down on a cleared approach, and the corridor proof may let it hop
    // at micro-lift height. The reposition time model prices exactly these passes, and the
    // assembly below pushes exactly these passes when the lift is chosen -- one plan, so the
    // priced lift is the emitted lift. Measured before this (astra, gt_fix8, finishing feed
    // 200): the selector priced a full-clearance lift at 13436 ms and kept a 12463 ms wall arc,
    // while the emitted lift was a 2 mm micro-lift and the whole lifted program ran 1038.8 ms
    // faster. Two shapes, as the two lift branches below assemble them:
    //   - cleanup fired (case iii): the entry ride's landing is gated (shrunk or dropped when
    //     it would land on uncut stock), the gate reads the stream with the exit ride already
    //     pushed, and the surviving entry ride follows the lift when the cut is not re-seamed;
    //   - no cleanup: the plain base link's landing, gated the same way.
    // The gate's fail-loud lines are held and printed only when this lift is pushed.
    type LiftAssembly = { passes: AdaptivePass[]; link: Extract<AdaptivePass, { type: 'link' }> | null; routed: AdaptivePass[]; entryRide: WallFollowRide | null; cutStartIndex: number; warnings: string[] }
    let liftAssemblyMemo: LiftAssembly | null = null
    const liftAssembly = (): LiftAssembly => {
      if (liftAssemblyMemo) return liftAssemblyMemo
      const warnings: string[] = []
      const warn = (message: string): void => { warnings.push(message) }
      const cleanupFired = !!(exitRide || entryRide)
      // LIFT-LANDING GATE (B8 follow-up, 2026-06-12): emit plunges STRAIGHT DOWN at the
      // lift's landing point. A plain landing (nextPoint, the engagement walker's point) is
      // safe by construction -- its bite is bounded by the walker's engage band. But the
      // cusp ENTRY ride relocates the landing to entryRide.far with NO material-state check:
      // measured on the Bar fixture, a relocated landing sat 3.5mm outside cleared stock =
      // a 97%-uncut full-width center plunge (R1 material safety / R2 optimal load).
      // Validate the tool-radius landing disk against clearedBeforePass (the PHYSICAL state
      // when the plunge executes -- same rationale as the B8 ride gate above). On a trip,
      // SHRINK the entry ride adaptively (same spirit as wallCleanLoop's reduced-Rf retry
      // ladder): each candidate is REBUILT by buildWallFollowEntry at half the previous
      // length -- the same wall-walking construction, just shorter, so it stays a true
      // sub-polyline of the wall ending exactly at B. If no useful length lands safely,
      // DROP the relocation entirely so the landing returns to the walker's safe point.
      let liftEntryRide = entryRide
      let liftConnEnd = connEnd
      if (cleanupFired && entryRide) {
        const frac = landingDiskUncutFraction(entryRide.far, clearedBeforePass, toolRadius, arcTol)
        if (frac > landingUncutCap) {
          const origLen = polylineLength(entryRide.points)
          let resolved: WallFollowRide | null = null
          let L = origLen
          for (let k = 0; k < 3; k++) {
            L = L / 2
            if (L < MIN_LANDING_RIDE_LEN) break
            const shrunk = buildWallFollowEntry(points, cutRegion, toolRadius, L, loopbackFilletPct)
            if (!shrunk) break
            if (landingDiskUncutFraction(shrunk.far, clearedBeforePass, toolRadius, arcTol) <= landingUncutCap) {
              resolved = shrunk
              break
            }
          }
          if (resolved) {
            // ADR-0003 fail-loud: name the rejected landing, its uncut fraction, and the fix.
            warn(`[lift-landing] entry-ride landing REJECTED: disk at (${entryRide.far.x.toFixed(2)}, ${entryRide.far.y.toFixed(2)}) is ${(frac * 100).toFixed(1)}% uncut > cap ${(landingUncutCap * 100).toFixed(0)}% -- entry ride shrunk ${origLen.toFixed(2)}mm -> ${polylineLength(resolved.points).toFixed(2)}mm, landing now (${resolved.far.x.toFixed(2)}, ${resolved.far.y.toFixed(2)})`)
            liftEntryRide = resolved
            liftConnEnd = resolved.far
          } else {
            warn(`[lift-landing] entry-ride landing REJECTED: disk at (${entryRide.far.x.toFixed(2)}, ${entryRide.far.y.toFixed(2)}) is ${(frac * 100).toFixed(1)}% uncut > cap ${(landingUncutCap * 100).toFixed(0)}% and no shrunk ride lands safely -- dropping the entry-ride relocation, landing at the walker point (${nextPoint.x.toFixed(2)}, ${nextPoint.y.toFixed(2)})`)
            liftEntryRide = null
            liftConnEnd = nextPoint
          }
        }
      }
      // The exit ride is pushed before the lift, so the gate's prior-motion evidence holds it.
      const gatePasses = exitRide ? [...passes, { type: 'wallfollow' as const, points: exitRide.points }] : passes
      const source = cleanupFired ? connStart : lastPoint
      const plan = cleanupFired
        ? planGatedLanding({ ...landingGate, passes: gatePasses, warn }, connStart, liftConnEnd, liftEntryRide?.points[1] ?? points[1] ?? liftConnEnd)
        : planGatedLanding({ ...landingGate, warn }, lastPoint, nextPoint, points[1] ?? nextPoint)
      const out: AdaptivePass[] = []
      const routed: AdaptivePass[] = []
      let link: Extract<AdaptivePass, { type: 'link' }> | null = null
      if (plan.keepDownApproach) {
        const approach = plan.keepDownApproach
        if (approach.departure) out.push({ type: 'lead', points: approach.departure })
        const travelPass: AdaptivePass = { type: 'loopback', points: approach.travel }
        routed.push(travelPass)
        out.push(travelPass)
        out.push({ type: 'lead', points: approach.lead })
      } else {
        link = { type: 'link', points: [source, plan.landing], jumpType: 2 }
        if (!cleanupFired && boundarySpan) link.boundarySpan = boundarySpan // Phase A: inert, does not affect emit
        if (plan.helix) link.helixDescent = plan.helix
        if (plan.clearAirLanding) link.clearAirLanding = true
        attachFallbackHelix(link)
        attachMicroLift(link)
        out.push(link)
        if (plan.lead) out.push({ type: 'lead', points: plan.lead })
      }
      const cutStart = plan.cutStartIndex ?? 0
      const rideAfter = cleanupFired && cutStart === 0 ? liftEntryRide : null
      if (rideAfter) out.push({ type: 'wallfollow', points: rideAfter.points })
      liftAssemblyMemo = { passes: out, link, routed, entryRide: rideAfter, cutStartIndex: cutStart, warnings }
      return liftAssemblyMemo
    }
    // Push the planned lift (after the exit ride, when there is one): its fail-loud lines, its
    // reason, the passes, and the cut's re-seam.
    const pushLiftAssembly = (reason: string): void => {
      const lift = liftAssembly()
      for (const message of lift.warnings) console.warn(message)
      if (lift.link) setLiftReason(lift.link, reason)
      for (const pass of lift.passes) {
        if (pass.type === 'wallfollow' && lift.entryRide && pass.points === lift.entryRide.points) {
          assertInsideCutRegion(pass.points, cutTree, wallTol, 'cusp entry')
        }
        if (lift.routed.includes(pass)) ROUTED_LOOPBACKS.add(pass)
        passes.push(pass)
      }
      cutStartIndex = lift.cutStartIndex
    }
    // WO-2787 round 7: machine time of that lift against staying down, over every level: the
    // planned lift and the cut it lands into, less what a kept-down ride is followed by (the
    // entry ride, then the whole cut). The exit ride before both is common and left out, so a
    // ride is still priced as its own passes alone (estimateRepositionMs).
    const liftPriceMs = (model: RepositionTimeModel): number => {
      const lift = liftAssembly()
      const landed = [...lift.passes, ...emittedCutPasses(lift.cutStartIndex,
        lift.cutStartIndex > 0 ? (lastLeadEnd(lift.passes) ?? lastLeadEnd(passes)) : undefined)]
      const stayed: AdaptivePass[] = [...(entryRide ? [{ type: 'wallfollow' as const, points: entryRide.points }] : []), ...emittedCutPasses(0, undefined)]
      return estimatePassesMs(landed, connStart, model) - estimatePassesMs(stayed, connEnd, model) + liftCoverMs(model)
    }
    // WO-2787 round 7: the gap-fill time of wall that is newly covered when `rides` follow the
    // exit ride, against the entry ride alone (what every kept-down ride ends with). A ride is
    // credited what it spares; the lift is charged the entry ride it shrinks or drops.
    const coverMm = (model: RepositionTimeModel, rides: Pt[][]): number =>
      model.wallGapMm ? model.wallGapMm(rides, exitRide ? [exitRide.points] : []) : 0
    const entryCoverMm = (model: RepositionTimeModel): number => entryRide ? coverMm(model, [entryRide.points]) : 0
    const liftCoverMs = (model: RepositionTimeModel): number => {
      if (!model.wallGapMm) return 0
      const kept = liftAssembly().entryRide
      return estimateWallGapMs(entryCoverMm(model) - (kept ? coverMm(model, [kept.points]) : 0), model)
    }
    const rideCoverMs = (model: RepositionTimeModel, ride: { points: Pt[]; kind: 'wallfollow' | 'loopback'; feedFrom?: number }): number => {
      if (!model.wallGapMm) return 0
      const walls = ridePasses(ride).filter(pass => pass.type === 'wallfollow').map(pass => pass.points)
      if (walls.length === 0) return 0
      return estimateWallGapMs(coverMm(model, [...walls, ...(entryRide ? [entryRide.points] : [])]) - entryCoverMm(model), model)
    }

    // ── Phase 2: RETRACT-ELIMINATION (the only keep-down-vs-lift decision) ───────────────
    // A kept-down connection cuts at depth, so it must be safe on two counts:
    //  (B) overload -- the swept corridor must lie inside already-cleared stock (else it
    //      plows uncut roughing material). Half-radius corridor, as FreeCAD: the endpoints
    //      sit on the cut frontier, so a full-radius test false-positives there.
    //  (A) finish gouge -- the tool CENTRE must stay inside the cut-region (which already
    //      insets toolRadius + stock-to-leave). A chord whose centre crosses into a wall /
    //      island keep-out gouges the finish stock.
    const corridor = capsulePath(connStart, connEnd, toolRadius * 0.5, arcTol)
    // totalArea (absolute) is intentional: this is a PRESENCE test (any uncut material
    // in the corridor at all), not a net quantity -- absolute >= net and is > 0 iff the
    // difference is non-empty, so it can only be MORE conservative about keeping down.
    const plowsUncut = totalArea(difference(corridor, cleared)) > 1e-6
    // WO-1235: under the single-owner 3D wall contract the pass and wall-ride endpoints sit
    // EXACTLY on the cut frontier (finishStock carries no tolerance/2 inset), so a chord that
    // runs ALONG a straight frontier edge has every interior sample on the edge and the
    // tolerance-free in/out test reads floating-point contact as a gouge. That contract
    // therefore judges the chord by its dense re-sample with the contract's 1e-4 mm contact
    // allowance INSTEAD of the tolerance-free test, not in addition to it. The allowance is
    // NOT the engine's wallTol: a zero-stock-to-leave wall (the dome) has the model itself at
    // the frontier, and a 3.8 mm chord across a 16 mm circular wall bows 0.11 mm into it,
    // inside wallTol and refused by the retained-model gate. 2D callers are unchanged.
    // WO-1896: the connection INTO a wall-finishing ring gets the same 1e-4 mm contact
    // allowance, on the SAME samples as the tolerance-free test (one per half radius,
    // endpoints excluded). The ring IS the frontier, so its seam sits on it, and the chord
    // from a tool that ended its clearing beside the seam runs along the frontier edge. pip2
    // is a +x ray cast with no on-boundary state: an on-edge sample reads INSIDE on a left or
    // bottom edge and OUTSIDE on a right or top edge. On the engagement pocket the climb
    // stream ends each chamber on its RIGHT wall, 0.38 mm from the ring's corner seam -- the
    // mirror of the conventional stream's left wall -- and the tolerance-free test called that
    // keep-down a gouge; the tool lifted and spiralled down beside the standing corner
    // (WO-1901's defect, one per level). A sample more than 1e-4 mm outside is still a gouge.
    const tolFreeExit = !strictWallFlow && centrePathExitsCutRegion(connStart, connEnd, cutTree, toolRadius)
    const gougesFinish = strictWallFlow
      ? routeEscapingSegment([connStart, connEnd], cutTree, Math.min(toolRadius, 0.1), 1e-4) >= 0
      : ringEntry && tolFreeExit
        ? routeEscapingSegment([connStart, connEnd], cutTree, toolRadius, 1e-4) >= 0
        : tolFreeExit
    // ...but the allowance clears a GOUGE, not a traverse. A keep-down posts as a traverse at
    // depth, and a chord along the ring still has the ring's own wall band under its full sweep
    // wherever the ring has not cut yet (WO-1194 requests 6 and 14: a 4.27 mm chord sweeping
    // 0.9 mm2; WO-1901's 0.38 mm corner chord). Such a chord is not kept down: it goes to the
    // tiers below as a non-gouging lift candidate -- tier 0 cuts it through at feed under its
    // overload cap, else the wall-follow ladder rides it fed and gated -- the same full-radius
    // sweep test WO-1235 uses below.
    const ringEntryRubs = ringEntry && tolFreeExit && !gougesFinish && (() => {
      const sweep = offsetOpenRound([connStart, connEnd], toolRadius, arcTol)
      return sweep.length > 0
        && maxInscribedRadius(difference(sweep, clearedBeforePass), toolRadius, Math.max(arcTol, 0.01)) > arcTol
    })()
    // WO-1235: a reversed wall direction only matters where the cutter's edge meets material.
    // A hop across a convex corner, or a chord through cleared stock beside a wall the pass
    // already finished, removes nothing in either direction; vetoing it bought the taper boss
    // six times its retracts and made Operator's modelled slab plan 8x slower (every forced lift
    // runs the landing gate). The full-radius sweep against the cleared belief is the test;
    // wherever the wall band is still standing, the reversed ride stays refused.
    const sweepTouchesUncut = (route: Pt[]): boolean => {
      const sweep = offsetOpenRound(route, toolRadius, arcTol)
      if (sweep.length === 0) return false
      return maxInscribedRadius(difference(sweep, cleared), toolRadius, Math.max(arcTol, 0.01)) > arcTol
    }
    // ...but only for a hop long enough to BE a route. A sub-tolerance corner
    // step removes nothing either way, so the sweep test always clears it and a
    // reversal of a thousandth of a radian would ride through - which is exactly
    // what `adaptiveWallBand` pins against ("clears the square perimeter once").
    // Below `near` the old strict rule stands: no at-depth link reverses along a
    // wall, however small. Above it, the sweep decides.
    const flowRouteIsRideable = (route: readonly Pt[]): boolean =>
      polylineLength(route as Pt[]) > toolRadius * 0.1

    const reverseWall = strictWallFlow
      && !wallRouteKeepsDirection([connStart, connEnd], wallLoops, millingDirection, toolRadius * 0.1)
      && (!flowRouteIsRideable([connStart, connEnd]) || sweepTouchesUncut([connStart, connEnd]))
    const jumpType: 1 | 2 = (plowsUncut || gougesFinish || reverseWall || ringEntryRubs) ? 2 : 1

    const liftRecoveryParts: string[] = []

    // ── Phase 2b: TIER 0 -- CUT-THROUGH (WO-436) ─────────────────────────────────────────
    // FreeCAD's IsAllowedToCutTrough (Adaptive.cpp:3196-3219) is a RESCUE from a retract,
    // never a substitute for an already-safe keep-down: the ancestor tries the ordinary
    // clear-path (tier 1) test FIRST, and only when that FAILS does it check whether the
    // short straight connection can legally cut through instead of retracting. Ported the
    // same way here -- tier 0 is only even attempted when jumpType is already 2 (this
    // connection was about to lift); a connection tier 1 already resolves for free never
    // reaches this code (a jumpType-1 plain link is the CHEAPER tier and stays that way --
    // firing tier 0 on it would be "skipping to a more expensive tier when a cheaper proof
    // already passed," which section 3 calls a quality defect in the other direction).
    // gougesFinish is an absolute veto regardless of load. Never on a re-seed link (entry
    // present): that is a genuinely disconnected region whose own helix/plunge must open
    // it, never a straight cut-through. Direction: connStart -> connEnd is the SAME forward
    // order the whole pass stream already walks in (never swapped), so this never reverses
    // the cutting direction (R3, one direction at a time, climb default -- OPERATOR 2026-08-22).
    // A qualifying connection never reaches the jumpType-2 assembly/link-emission machinery
    // below (the wall-follow rescue ladder, the lift-landing gate, the liftReason link).
    const chordLen = Math.hypot(connEnd.x - connStart.x, connEnd.y - connStart.y)
    let cutThroughEmitted = false
    if (jumpType === 2 && !entry && !reverseWall && chordLen <= 2 * stepOverDistance) {
      if (gougesFinish) {
        liftRecoveryParts.push('cutthrough-gouge')
        console.warn(`[cutthrough] rejected (gouge): chord ${chordLen.toFixed(2)}mm from (${connStart.x.toFixed(2)}, ${connStart.y.toFixed(2)}) to (${connEnd.x.toFixed(2)}, ${connEnd.y.toFixed(2)}) -- tool centre would leave cutRegion -- lifting instead`)
      } else {
        // WO-1178 (WO-430 item 4b): the over-cut ceiling 2 x optimal is 80% of a slot at a
        // 0.4D stepover, over the 75%-of-slot engagement gate every consumer downstream holds a
        // fed move to -- the uploaded bore died on exactly one such 4.7 mm cut-through at 78%.
        // A fed connection is held to the lower of the two: the over-cut ceiling, and the gate.
        const cutThroughCap = Math.min(AP.caps.cutThroughOptimalMultiple * optimal, AP.caps.slotCeilingDiameters * (2 * toolRadius))
        const cutThroughOverload = rideOverloadsUncut(
          [connStart, connEnd], clearedBeforePass, toolRadius, cutThroughCap, arcTol,
        )
        if (!cutThroughOverload) {
          if (exitRide) {
            assertInsideCutRegion(exitRide.points, cutTree, wallTol, 'cusp exit')
            passes.push({ type: 'wallfollow', points: exitRide.points })
          }
          passes.push({ type: 'cut', points: [connStart, connEnd] })
          // It sweeps like any cut, so it folds into the cleared belief the same way a
          // pass does (expandCleared) -- materials accounting stays honest downstream.
          cleared = expandCleared(cleared, [connStart, connEnd], toolRadius, arcTol)
          if (entryRide) {
            assertInsideCutRegion(entryRide.points, cutTree, wallTol, 'cusp entry')
            passes.push({ type: 'wallfollow', points: entryRide.points })
          }
          cutThroughEmitted = true
          console.warn(`[cutthrough] ACCEPTED: chord ${chordLen.toFixed(2)}mm from (${connStart.x.toFixed(2)}, ${connStart.y.toFixed(2)}) to (${connEnd.x.toFixed(2)}, ${connEnd.y.toFixed(2)}) cut through at feed instead of lifting (WO-436)`)
        } else {
          liftRecoveryParts.push('cutthrough-overload')
          console.warn(`[cutthrough] rejected (overload): chord ${chordLen.toFixed(2)}mm from (${connStart.x.toFixed(2)}, ${connStart.y.toFixed(2)}) to (${connEnd.x.toFixed(2)}, ${connEnd.y.toFixed(2)}) sustained effective width ${cutThroughOverload.width.toFixed(2)}mm > cap ${cutThroughCap.toFixed(2)}mm -- lifting instead`)
        }
      }
    }

    if (!cutThroughEmitted) {
    // WO-435 T1 attribution. liftBaseReason names the ORIGINAL cause (why a kept-down
    // connection is unsafe); liftRecoveryParts accumulates, as they are tried, which
    // cheaper recovery tiers (a failed tier-0 cut-through attempt, pushed above, then
    // wall-follow arc, alternate arc, through-cleared chord) were attempted and why they
    // failed. `liftReason` (the one this appendCutPass call will attach to whichever
    // jumpType-2 link it ends up pushing, if any) is finalized once it is known no tier
    // recovered the connection. A speculative push into liftRecoveryParts that a
    // later rung DOES recover is harmless: it is read only if the connection still lifts.
    const liftBaseReason = jumpType === 2
      ? `${plowsUncut && gougesFinish ? 'plow+gouge' : plowsUncut ? 'plow' : ringEntryRubs ? 'rub' : 'gouge'}@(${connStart.x.toFixed(1)}, ${connStart.y.toFixed(1)})`
      : undefined
    let liftReason: string | undefined

    // integralWallFollow rides the shared wall at depth in place of a lift, when the connection
    // would otherwise lift (jumpType 2) and its two ends share a boundary loop within a length
    // budget. This is the SOLE authority on keep-down-vs-lift; cleanup never touches it. Never on
    // a re-seed link (entry present): that is a genuinely new disconnected region whose plunge
    // entry must be kept -- never wall-follow + plunge into the same start.
    // WO-466: `feedFrom`, when present, is the index in `points` at which the ride stops
    // travelling and starts FEEDING -- the stop-short split. Absent on every other rung, and
    // every assembly branch below pushes the ride through pushConnectionRide, so an absent
    // value is byte-identical to the pre-WO-466 stream.
    let connectionRide: { points: Pt[]; kind: 'wallfollow' | 'loopback'; feedFrom?: number } | null = null
    if (integralWallFollow && jumpType === 2 && !entry) {
      const chord = Math.hypot(connEnd.x - connStart.x, connEnd.y - connStart.y)
      const cap = AP.caps.rideCapStepovers * stepOverDistance
      // Both boundary arcs between the endpoints, SHORTER-FIRST. arcs[0] is the DIRECT ride
      // (identical to the pre-B8-stage-2 boundaryArcBetween pick); arcs[1] is the OTHER way
      // round the shared wall (e.g. the far side of an island). arcs is [] when the two
      // endpoints do not project onto a shared boundary loop (no wall to ride -- e.g. each
      // endpoint hugs a DIFFERENT island); rung (b)(2) below covers that case.
      const arcs = boundaryArcsBetween(cutRegion, connStart, connEnd)
        .filter(arc => strictWallFlow
          ? wallRouteKeepsDirection(arc, wallLoops, millingDirection, toolRadius * 0.1)
            && routeEscapingSegment(arc, cutTree, Math.min(toolRadius, 0.1), 1e-4) < 0
          : wallPointsMatchDirection(arc, cutRegion, millingDirection))
      if (arcs.length === 0) liftRecoveryParts.push('no-wall')
      // 3D prefers the forward wall arc even when the endpoints are close across
      // its seam. Otherwise a chord-length budget rewards reversing at that seam.
      // Existing 2D callers retain the authored length-factor budget.
      const primary = (
        arcs.length > 0
        && (strictWallFlow || polylineLength(arcs[0]) <= integralWallFollowLengthFactor * chord)
      ) ? arcs[0] : null
      if (arcs.length > 0 && !primary) liftRecoveryParts.push('arc-too-long')
      // B8 GATE (substitution-without-revalidation fix): a kept-down ride replaces a lift the
      // chord test just proved UNSAFE, so the substituted geometry must itself be proven safe
      // against the PHYSICAL cleared state before it is kept down. Cap = 1.5x stepover effective
      // width: a legitimate ride is either over cleared stock (~0 fresh width) or the deliberate
      // wall-cleanup skim of a thin uncut wall sliver (sub-stepover); anything SUSTAINED above
      // 1.5x stepover is plowing uncleared roughing stock at depth (the B8 slot). Validate
      // against clearedBeforePass (NOT `cleared`): by the time this runs the NEW pass's corridor
      // is already folded into `cleared`, but the ride physically executes BEFORE that pass cuts
      // -- a ride judged against the future state can slot through the very lane the next cut
      // would have cleared.
      // WO-2787 fix round 4: THE CHOICE IS MADE BY MACHINE TIME when the caller supplies the
      // time model (engine/index.ts always does). Operator 2026-10-14: "What determines it from a
      // machinist standpoint is cycletime ... If we can get there faster ... by staying down ...
      // do that ... When the best option is a lift retract, straight reposition, plunge,
      // lead-in, and cleanup do that." Every rung below still proves its own candidate exactly
      // as before; what changes is that a proven ride is no longer taken just because it was
      // offered first. Each candidate is timed as emit.ts would write it, at every depth level,
      // through the app's own job estimate (repositionTime.ts), and so is the lift. The fastest
      // wins; a ride that ties the lift stays down, and between rides the earlier rung keeps a
      // tie. A candidate that cannot beat the current choice is not proven at all -- the
      // proofs are the expensive part -- and is recorded with its time as slower. Without the
      // model the first proven rung wins, byte-identical to the ladder before it.
      const timeModel = repositionTime
      const liftMs = timeModel ? liftPriceMs(timeModel) : Infinity
      // The diagnostic hook outranks the whole-program check's own trials, so a test that
      // forces a rung gets the program the product would emit around that rung.
      const forced = timeModel ? (repositionChoiceForce?.(connStart, connEnd) ?? timeModel.force?.(connStart, connEnd) ?? null) : null
      let rideMs = Infinity
      const choice: { rung: string; commit: (() => void) | null } = { rung: 'lift', commit: null }
      const weighed: RepositionChoiceTrace['candidates'] = []
      type Ride = { points: Pt[]; kind: 'wallfollow' | 'loopback'; feedFrom?: number }
      const rideTime = (ride: Ride): number => timeModel ? estimateRepositionMs(ride, timeModel) - rideCoverMs(timeModel, ride) : 0
      // Still looking: the first-rung ladder stops at its first ride; the timed one weighs on.
      const open = (): boolean => timeModel !== null || !connectionRide
      const note = (rung: string, ride: Ride, ms: number, outcome: 'feasible' | 'refused' | 'slower', reason?: string): void => {
        if (timeModel) {
          const coverMs = ride.points.length >= 2 ? rideCoverMs(timeModel, ride) : 0
          weighed.push({ rung, kind: ride.kind, points: ride.points, feedFrom: ride.feedFrom, ms, outcome, ...(reason ? { reason } : {}), ...(coverMs ? { coverMs } : {}) })
        }
      }
      const at = (p: Pt): string => `(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`
      const canWin = (rung: string, ride: Ride, ms: number): boolean => {
        if (!timeModel) return !connectionRide
        if (forced !== null) return rung === forced && !connectionRide
        if (ms <= liftMs && ms < rideMs) return true
        note(rung, ride, ms, 'slower')
        liftRecoveryParts.push(`${rung}-slower(${(ms / 1000).toFixed(2)}s)`)
        return false
      }
      // Returns the ride so each call site assigns connectionRide where the compiler sees it.
      const take = (rung: string, ride: Ride, ms: number, commit: () => void): Ride => {
        note(rung, ride, ms, 'feasible')
        if (!timeModel) { commit(); return ride }
        rideMs = ms
        choice.rung = rung
        choice.commit = commit
        return ride
      }

      // WO-3037 (switch, default OFF): smooth keep-down links that never ride through standing stock.
      const smoothLinks = ADAPTIVE_MOTION_SWITCHES.keepDownLinksSmooth
      const standingAt = (route: Pt[]): Pt | null => smoothLinks ? rideMeetsStandingStock(route, clearedBeforePass, toolRadius, arcTol) : null

      const directOverload = primary ? rideOverloadsUncut(primary, clearedBeforePass, toolRadius, cap, arcTol) : null
      if (primary && !directOverload) {
        const ride: Ride = { points: primary, kind: 'wallfollow' }
        const ms = rideTime(ride)
        if (canWin('wall-arc', ride, ms)) connectionRide = take('wall-arc', ride, ms, () => {})
      } else if (primary && directOverload) {
        liftRecoveryParts.push('arc-overload')
        note('wall-arc', { points: primary, kind: 'wallfollow' }, rideTime({ points: primary, kind: 'wallfollow' }), 'refused',
          `${directOverload.width.toFixed(2)}mm sustained > ${cap.toFixed(2)}mm cap near ${at(directOverload.at)}`)
      }

      // Rung (b)(1) ROUTE-AROUND -- the OTHER boundary arc (B8 stage 2). Only when the direct
      // ride existed and was rejected: try to stay down on an alternate boundary arc, gated by
      // the SAME material-safety check. The alternate is bounded only by the single loop it
      // rides (island wraps are legitimately longer than the chord; length is a deferred quality
      // tradeoff, not a safety gate -- plan section 5 risk 2), so it is NOT held to the direct
      // ride length-factor budget. First safe alternate wins (shorter-first).
      if (open() && primary && directOverload) {
        for (let ai = 1; ai < arcs.length; ai++) {
          const ride: Ride = { points: arcs[ai], kind: 'wallfollow' }
          const ms = rideTime(ride)
          if (!canWin('wall-arc-around', ride, ms)) continue
          const aroundOverload = rideOverloadsUncut(arcs[ai], clearedBeforePass, toolRadius, cap, arcTol)
          if (aroundOverload) { note('wall-arc-around', ride, ms, 'refused', `${aroundOverload.width.toFixed(2)}mm sustained > ${cap.toFixed(2)}mm cap near ${at(aroundOverload.at)}`); continue }
          connectionRide = take('wall-arc-around', ride, ms, () => {
            b8GateStats.routedAround++
            // ADR-0003 fail-loud: name the reroute (the direct ride was unsafe, but we did NOT
            // lift -- an alternate at-depth route over cleared stock was found).
            console.warn(`[integral-wallfollow] direct ride REJECTED (B8 engagement gate): sustained effective cut width ${directOverload.width.toFixed(2)}mm > cap ${cap.toFixed(2)}mm near (${directOverload.at.x.toFixed(2)}, ${directOverload.at.y.toFixed(2)}) -- ROUTED AROUND on the alternate boundary arc (${polylineLength(arcs[ai]).toFixed(1)}mm) instead of lifting`)
          })
          break
        }
      }

      // Rung (b)(2) THROUGH-CLEARED CHORD (B8 stage 3). Offered as the last route-around option
      // when NO boundary arc kept the ride down -- either both boundary arcs slotted (primary
      // existed but was rejected and every alternate also overloaded), or the endpoints share no
      // wall at all (arcs === [], primary null, e.g. each endpoint hugs a different island so
      // the safe route crosses the OPEN cleared field between them rather than hugging either
      // wall). The candidate is the straight chord connStart->connEnd through ALREADY-CLEARED
      // stock, sanctioned by AC-SPEC R1 ("rapids/bridges/loopbacks THROUGH cleared stock are
      // allowed"). It is legal only if BOTH:
      //   - its tool CENTRE stays inside the machinable cut-region (no finish gouge / island
      //     keep-out crossing) -- reuse gougesFinish, already computed for the jumpType decision
      //     on this exact chord; a chord that gouges is never a safe route, so skip it; and
      //   - it does not SUSTAIN-overload uncut stock -- the SAME rideOverloadsUncut gate (full
      //     tool width, 1.5x stepover, vs clearedBeforePass) the boundary arcs are held to.
      // No loop bounds the chord, but length is a deferred quality tradeoff, not a safety gate
      // (plan section 5 risk 2), exactly as for the alternate arc.
      if (open() && !gougesFinish) {
        const chordRide: Ride = { points: [connStart, connEnd], kind: 'loopback' }
        const ms = rideTime(chordRide)
        if (canWin('chord', chordRide, ms)) {
          const chordOverload = rideOverloadsUncut(chordRide.points, clearedBeforePass, toolRadius, cap, arcTol)
          const chordStanding = chordOverload ? null : standingAt(chordRide.points)
          if (chordStanding) {
            liftRecoveryParts.push('chord-standing')
            note('chord', chordRide, ms, 'refused', `meets standing stock near ${at(chordStanding)} (WO-3037)`)
          } else if (!chordOverload) {
            connectionRide = take('chord', chordRide, ms, () => {
              b8GateStats.routedAroundChord++
              // ADR-0003 fail-loud: name the reroute (no safe boundary arc, but a straight at-depth
              // route over cleared stock was found instead of conceding the retract).
              console.warn(`[integral-wallfollow] no safe boundary arc (${primary ? 'arcs slotted' : 'endpoints share no wall'}) -- ROUTED AROUND on the through-cleared straight chord (${chord.toFixed(1)}mm) instead of lifting`)
            })
          } else {
            liftRecoveryParts.push('chord-overload')
            note('chord', chordRide, ms, 'refused', `${chordOverload.width.toFixed(2)}mm sustained > ${cap.toFixed(2)}mm cap near ${at(chordOverload.at)}`)
          }
        }
      }

      // Rung (b)(3) THE SAME WALL RIDE, UNDER THE TIER-1 DETOUR BUDGET (WO-438).
      // Rung (a) offers the DIRECT boundary arc but rejects it on the wall-follow length
      // factor (default 2x the chord), and rung (b)(1) only ever runs when a primary ride
      // EXISTED and overloaded -- so an arc rejected purely for LENGTH is never retried by
      // anything, and the connection lifts over a wall it could have ridden. GOOD-SPEC section
      // 3 sets the length question at tier 1 as a DETOUR BUDGET, and the ancestor's own budget
      // is keepToolDownDistRatio (>= 3x direct, Adaptive.cpp:2791,2904) -- looser than the
      // wall-follow factor. Retry the same arcs under that budget. EVERYTHING ELSE IS
      // UNCHANGED: same direction filter (this is a cutting-role wall ride, so R3's one-
      // direction rule binds it exactly as it binds rung (a)), same 'wallfollow' role at
      // cutting feed, same rideOverloadsUncut proof at the same 1.5x-stepover cap against the
      // physical clearedBeforePass. Only the length bound moves, and only in the direction
      // GOOD-SPEC and the ancestor both name. Shorter arc first.
      // WO-2787 fix round 4: with the time model the budget IS the time -- an arc of any length
      // is weighed against the lift, and the fixed 3x-direct ratio no longer applies.
      if (open() && arcs.length > 0) {
        const travelBudget = timeModel ? Infinity : KEEP_TOOL_DOWN_DIST_RATIO * chord
        let overBudget = 0
        for (const arc of arcs) {
          if (connectionRide && connectionRide.points === arc) continue
          if (polylineLength(arc) > travelBudget) { overBudget++; continue }
          const ride: Ride = { points: arc, kind: 'wallfollow' }
          const ms = rideTime(ride)
          if (!canWin('wall-arc-detour', ride, ms)) continue
          const detourOverload = rideOverloadsUncut(arc, clearedBeforePass, toolRadius, cap, arcTol)
          if (detourOverload) { note('wall-arc-detour', ride, ms, 'refused', `${detourOverload.width.toFixed(2)}mm sustained > ${cap.toFixed(2)}mm cap near ${at(detourOverload.at)}`); continue }
          connectionRide = take('wall-arc-detour', ride, ms, () => {
            b8GateStats.routedDetour++
            console.warn(timeModel
              ? `[keepdown-route] wall ride rejected on the wall-follow length factor -- ACCEPTED as the fastest reposition (${polylineLength(arc).toFixed(1)}mm, ${(ms / 1000).toFixed(2)}s against a ${(liftMs / 1000).toFixed(2)}s lift) instead of lifting (WO-438, WO-2787)`
              : `[keepdown-route] wall ride rejected on the wall-follow length factor -- ACCEPTED under the tier-1 detour budget (${polylineLength(arc).toFixed(1)}mm <= ${travelBudget.toFixed(1)}mm = ${KEEP_TOOL_DOWN_DIST_RATIO}x direct ${chord.toFixed(1)}mm) instead of lifting (WO-438)`)
          })
          break
        }
        if (!connectionRide && overBudget === arcs.length) liftRecoveryParts.push('backtrack-detour>budget')
      }

      // Rung (b)(3b) THE BOWED HOP (WO-3037, switch keepDownLinksSmooth, default OFF). The owner
      // 2026-10-21 on the form torus: "there would be no reason a part of this smooth geometry
      // would have spikes in the toolpath that look like this." The spikes were rung (b)(4)'s
      // perpendicular detours: a 1-3 mm hop between two points on the curved torus wall whose
      // straight chord is clear of stock but whose tool centre sags ~0.05 mm past the wall
      // (gougesFinish), with the wall arc itself barred by the milling-direction rule, so the
      // search fed 2.5 mm out into cleared space and turned back by 120-140 deg. The hop the
      // geometry asks for is the chord bowed just enough to stay off the wall: a shallow arc,
      // tried at growing sagittas on both sides, its end tangents never more than 2 atan(0.8)
      // = 77 deg off the chord. It is TRAVEL like the routed ride (a loopback) and meets every
      // proof that ride meets -- tool centre inside the region, no air excursion, the traverse
      // cap against the physical pre-move belief -- plus the chord's own tolerance-free wall
      // test and the standing-stock test.
      // Without the time model the first proven rung wins, so a bowed hop is held back and
      // weighed against the routed ride by LENGTH there: the shorter of the two is taken.
      let heldHop: Pt[] | null = null
      const takeHop = (hop: Pt[], ms: number): Ride => take('bowed-hop', { points: hop, kind: 'loopback' }, ms, () => {
        b8GateStats.routedDetour++
        console.warn(`[keepdown-route] straight hop would graze the wall -- BOWED HOP at depth (${polylineLength(hop).toFixed(2)}mm against the ${chord.toFixed(2)}mm chord) instead of a detour or a lift (WO-3037)`)
      })
      if (open() && smoothLinks) {
        const traverseCap = traverseKeepDownCap(stepOverDistance, optimal, arcTol)
        const hopWallTol = Math.max(arcTol * AP.sampling.wallTolArcTols, toolRadius * AP.sampling.wallTolToolRadii)
        const staysOffWall = (route: Pt[]): boolean => strictWallFlow
          ? routeEscapingSegment(route, cutTree, Math.min(toolRadius, 0.1), 1e-4) < 0
          : route.every((p, k) => k === 0 || !centrePathExitsCutRegion(route[k - 1], p, cutTree, toolRadius))
        const proves = (route: Pt[]): boolean => staysOffWall(route)
          && routeEscapingSegment(route, cutTree, toolRadius, hopWallTol) < 0
          && !(exteriorAirDepthAt && routeAirExcursion(route, exteriorAirDepthAt, toolRadius, hopWallTol))
          && !rideOverloadsUncut(route, clearedBeforePass, toolRadius, traverseCap, arcTol)
          && !standingAt(route)
        // WO-3068 (owner 2026-10-22 on the WO-3037 card: "Seems like a larger radius but have a
        // shorter path"): on one chord an arc's length grows with its sagitta, so the flattest arc
        // that proves is both the shortest and the largest radius. The steps below are coarse --
        // on the torus a 13 mm hop whose 25% bow met standing stock took the 40% one when 32%
        // proved -- so once a step proves, each side that proved there is searched down toward
        // the step below for the flattest arc that still meets every proof, and the shorter of
        // the two sides is taken. Every arc taken has met every proof above; the search only
        // decides which proven arc.
        let hop: Pt[] | null = null
        if (chord > 1e-6) {
          const steps = [0.02, 0.04, 0.08, 0.15, 0.25, 0.4]
          search: for (let i = 0; i < steps.length; i++) {
            for (const side of [1, -1] as const) {
              const route = bowedHop(connStart, connEnd, steps[i] * chord, side, arcTol)
              if (!proves(route)) continue
              let lo = i > 0 ? steps[i - 1] : 0, hi = steps[i], best = route
              for (let k = 0; k < BOWED_HOP_REFINE_STEPS; k++) {
                const mid = (lo + hi) / 2
                const flatter = bowedHop(connStart, connEnd, mid * chord, side, arcTol)
                if (proves(flatter)) { hi = mid; best = flatter } else lo = mid
              }
              if (!hop || polylineLength(best) < polylineLength(hop)) hop = best
            }
            if (hop) break search
          }
        }
        if (hop && !timeModel) {
          heldHop = hop
        } else if (hop) {
          const ride: Ride = { points: hop, kind: 'loopback' }
          const ms = rideTime(ride)
          if (canWin('bowed-hop', ride, ms)) connectionRide = takeHop(hop, ms)
        } else {
          liftRecoveryParts.push('bowed-hop-refused')
        }
      }

      // Rung (b)(4) ROUTED KEEP-DOWN (WO-438, the port of the ancestor's ResolveLinkPath).
      // A single straight chord or a single boundary arc is not the only at-depth route
      // between two points in one connected cleared region: the ancestor searches for a
      // MULTI-SEGMENT route -- backtrack along the cutter's own just-cut track (AC-SPEC E.3,
      // cleared BY CONSTRUCTION), or a perpendicular detour around the obstruction -- and only
      // retracts when nothing inside its keepToolDownDistRatio detour budget is clear. Ported
      // here as the last tier-1 rung: the tool centre must stay inside cutRegion on every
      // segment, and the whole ride must pass the measured sustained-load window against the
      // PHYSICAL clearedBeforePass -- at the TRAVERSE bound below, not the cutting-role cap.
      // Offered even when the DIRECT chord gouges: a route that bends around the wall/island
      // is a different path and proves itself. R3/T5 note: these are opposite-sense TRAVEL
      // moves at traverse speed over ground the proof shows is already clear -- a loopback,
      // not a cut, and never an uncut allowance.
      // WO-2787 fix round 4: with the time model the length budget is the distance a
      // fast-traverse loopback covers, over every level, in the time of the current best
      // choice (the lift, or a faster ride already proven) -- not 3x the direct move. A
      // routed ride is never shorter than the direct chord, so a budget at or under it is
      // not searched.
      if (open()) {
        const budget = timeModel
          ? Math.min(liftMs, rideMs) / 60000 / Math.max(repositionLevelCount(timeModel), 1) * timeModel.ctx.feeds.fastTraverseRate
          : KEEP_TOOL_DOWN_DIST_RATIO * chord
        // T5, THE TRAVERSE BOUND. A routed ride is emitted as a LOOPBACK: rapid travel at
        // depth, not a cutting move, so it may not shave -- the 1.5x-stepover cap the
        // CUTTING-role wall rides above are held to would let a rapid remove a third of a
        // slot, and T5 allows a traverse no allowance at all. But "zero" cannot be measured as
        // literal presence, for two reasons that are both measurement, not indulgence:
        //   1. the belief's polygon faceting under-counts every swept track by ~0.5% at
        //      production arcTol, so a corridor edge always shows a sliver that is an ARTIFACT
        //      and not stock, and refusing on bare presence is precisely the escalation
        //      GOOD-SPEC section 4 forbids; and
        //   2. the ride ENDS at the next pass's engage point, which sits on the frontier BY
        //      DEFINITION -- its terminal window necessarily contains the very bite the next
        //      cut is about to take.
        // So the bound is that bite itself: ONE ENGAGE-BAND BITE of fresh stock, spread over
        // the measured 2 mm window. maxBite (1.5 x optimal x the walker's engage move) is the
        // largest bite the walker may hand the stepper -- bounded BY CONSTRUCTION by the
        // progress contract, not chosen here. A ride that meets more than one engage bite
        // anywhere is not sitting on its own terminus; it is crossing stock, and it lifts.
        // Measured on the corpus this is 4-7x tighter than the cutting-role cap.
        const traverseCap = traverseKeepDownCap(stepOverDistance, optimal, arcTol)
        const routed = (!timeModel || budget > chord)
          ? planKeepDownRoute(
            connStart, connEnd, prevCut!.points, collectPriorMotion(), buildTrackGraph(), clearedBeforePass, cutTree,
            toolRadius, stepOverDistance, arcTol, traverseCap, budget, exteriorAirDepthAt, onAcceptedGraphRoute,
            smoothLinks ? standingAt : null,
          )
          : null
        if (routed && smoothLinks) {
          // WO-3037: round what corners the route still has, where the rounded ride proves. A
          // round cuts each corner on its inside, toward whatever the corner was steering round,
          // so it is held to every proof the route met; failing that, a smaller round, else the
          // route as it was.
          const routeWallTol = Math.max(arcTol * AP.sampling.wallTolArcTols, toolRadius * AP.sampling.wallTolToolRadii)
          // WO-3068: the largest round that proves. When a share proves after a larger one did
          // not, the gap between them is searched upward for the largest share that still proves.
          const roundProves = (rounded: Pt[]): boolean => routeEscapingSegment(rounded, cutTree, toolRadius, routeWallTol) < 0
            && !(exteriorAirDepthAt && routeAirExcursion(rounded, exteriorAirDepthAt, toolRadius, routeWallTol))
            && !rideOverloadsUncut(rounded, clearedBeforePass, toolRadius, traverseCap, arcTol)
            && !standingAt(rounded)
          const shares = [0.45, 0.25, 0.12]
          for (let i = 0; i < shares.length; i++) {
            let rounded = roundRideCorners(routed.points, arcTol, shares[i])
            if (rounded.length === routed.points.length) break
            if (!roundProves(rounded)) continue
            let lo = shares[i], hi = i > 0 ? shares[i - 1] : lo
            for (let k = 0; hi > lo && k < BOWED_HOP_REFINE_STEPS; k++) {
              const mid = (lo + hi) / 2
              const larger = roundRideCorners(routed.points, arcTol, mid)
              if (roundProves(larger)) { lo = mid; rounded = larger } else hi = mid
            }
            routed.points = rounded
            routed.length = polylineLength(rounded)
            break
          }
        }
        if (heldHop && (!routed || polylineLength(heldHop) <= routed.length)) {
          connectionRide = takeHop(heldHop, 0)
        } else if (routed) {
          const ride: Ride = { points: routed.points, kind: 'loopback' }
          const ms = rideTime(ride)
          if (canWin(`routed-${routed.family}`, ride, ms)) {
            connectionRide = take(`routed-${routed.family}`, ride, ms, () => {
              b8GateStats.routedDetour++
              // ADR-0003 fail-loud: name the reroute and which family proved it.
              console.warn(timeModel
                ? `[keepdown-route] no faster arc or straight chord -- ROUTED AROUND at depth via ${routed.family} (${routed.points.length} pts, ${routed.length.toFixed(1)}mm, ${(ms / 1000).toFixed(2)}s against a ${(liftMs / 1000).toFixed(2)}s lift) instead of lifting (WO-438, WO-2787)`
                : `[keepdown-route] no safe arc or straight chord -- ROUTED AROUND at depth via ${routed.family} (${routed.points.length} pts, ${routed.length.toFixed(1)}mm <= budget ${budget.toFixed(1)}mm = ${KEEP_TOOL_DOWN_DIST_RATIO}x direct ${chord.toFixed(1)}mm) instead of lifting (WO-438)`)
            })
          }
        } else {
          liftRecoveryParts.push('route-detour>budget')
          note('routed', { points: [], kind: 'loopback' }, 0, 'refused', timeModel && budget <= chord
            ? `not searched: no route is shorter than the ${chord.toFixed(1)}mm direct move, and ${budget.toFixed(1)}mm is all the time allows`
            : `no backtrack, detour or cleared-track route within ${budget.toFixed(1)}mm stays under the ${traverseCap.toFixed(3)}mm traverse cap`)
        }
      }

      // Rung (b)(5) STOP SHORT OF THE SKIN AND FEED THE LAST BIT (WO-466; Operator 2026-08-22 on
      // the WO-447 card: "Also look at use of keep down travel moves to avoid retracts").
      // Every rung above judges its candidate as ONE object, so a connection whose ground is
      // clear until its last millimetres -- it ends ON the cut frontier, or beside a standing
      // rim -- concedes a full-clearance retract to cross ground the proof had already
      // cleared. Split it: travel at depth to where the SAME zero-tolerance traverse proof
      // stops clearing, then FEED the engaged tail under the SAME caps the tier-0 cut-through
      // meets. Offered LAST so no cheaper whole-corridor rung is skipped, and refused loudly
      // with the measured reason when it cannot prove -- in which case the retract stays.
      // WO-2787 fix round 4: a stop-short ride runs the direct chord, so with the time model it
      // is only planned while the chord at the faster of the two rates could still win.
      const stopShortFloorMs = timeModel
        ? Math.max(repositionLevelCount(timeModel), 1) * chord / Math.max(timeModel.ctx.feeds.fastTraverseRate, timeModel.ctx.feeds.feedRate) * 60000
        : 0
      if (open() && (!timeModel || (stopShortFloorMs <= liftMs && stopShortFloorMs < rideMs))) {
        // The SAME two bars this site already holds its other rungs to: rung (b)(4)'s T5
        // traverse cap for a move at traverse speed, and the tier-0 cut-through cap for a
        // move at feed. Neither is loosened for the split.
        const stopShortTraverseCap = traverseKeepDownCap(stepOverDistance, optimal, arcTol)
        const stopShortFeedCap = Math.min(AP.caps.cutThroughOptimalMultiple * optimal, AP.caps.slotCeilingDiameters * (2 * toolRadius)) // WO-1178: as the tier-0 cap above
        const stopShort = planStopShortKeepDown({
          source: connStart,
          target: connEnd,
          arcTol,
          gouges: (a, b) => centrePathExitsCutRegion(a, b, cutTree, toolRadius),
          travelClear: (a, b) => {
            const trip = rideOverloadsUncut([a, b], clearedBeforePass, toolRadius, stopShortTraverseCap, arcTol)
            if (trip) return `sustains ${trip.width.toFixed(3)}mm effective width > traverse cap ${stopShortTraverseCap.toFixed(3)}mm near (${trip.at.x.toFixed(2)}, ${trip.at.y.toFixed(2)})`
            // WO-3037: the travel leg hands over to a FED tail at its end, so only the bite at
            // its end may meet stock (switch OFF: never asked).
            const standing = standingAt([a, b])
            return standing ? `meets standing stock near (${standing.x.toFixed(2)}, ${standing.y.toFixed(2)}) (WO-3037)` : null
          },
          feedClear: (a, b) => {
            const trip = rideOverloadsUncut([a, b], clearedBeforePass, toolRadius, stopShortFeedCap, arcTol)
            return trip
              ? `sustains ${trip.width.toFixed(2)}mm effective width > cut-through cap ${stopShortFeedCap.toFixed(2)}mm near (${trip.at.x.toFixed(2)}, ${trip.at.y.toFixed(2)})`
              : null
          },
          feedLenCap: 2 * stepOverDistance,
        })
        if ('travel' in stopShort) {
          // A travel-less split (the whole-chord case) is exactly the engine's tier-0
          // cut-through, which ran above at the SAME length bar, the SAME load cap and the
          // SAME gouge veto -- so at this site it can only appear when tier 0 was skipped,
          // never as a second authority over a decision tier 0 already made.
          const ride: Ride = stopShort.travel.length >= 2
            ? { points: [stopShort.travel[0], stopShort.travel[1], stopShort.feed[1]], kind: 'loopback' as const, feedFrom: 1 }
            : { points: [stopShort.feed[0], stopShort.feed[1]], kind: 'loopback' as const, feedFrom: 0 }
          const ms = rideTime(ride)
          if (canWin('stop-short', ride, ms)) {
            connectionRide = take('stop-short', ride, ms, () => {
              b8GateStats.stoppedShort++
              // ADR-0003 fail-loud: name the rung that recovered the connection and its proof.
              console.warn(`[keepdown-stopshort] no safe arc, through-cleared chord or routed detour -- STAYED DOWN instead of lifting (WO-466): ${stopShort.reason}`)
            })
          }
        } else {
          liftRecoveryParts.push(`stopshort-refused(${stopShort.refused})`)
          note('stop-short', { points: [], kind: 'loopback' }, 0, 'refused', stopShort.refused)
        }
      }

      // Rung (b)(6) WALL CHAIN IN THE MILLING DIRECTION (WO-2787; Operator 2026-10-14 on
      // gt_two_island: "I need to understand the logic of why you wouldn't continue around
      // (wall follow the correct direction) ... Especially on an island perimeter."). Every
      // wall rung above pairs two points on ONE wall loop, so a connection from one island's
      // wall to another's ('no-wall') was only ever offered a straight chord, a stop-short and
      // detours inside the 3x-direct budget. Measured there: the reposition from island B's
      // wall to island A's lifted while the ride clockwise round B, across the 4 mm gap and
      // clockwise round A peaked at 0.44 mm against the 2.25 mm cap
      // (src/tests/evidence/WO-2787/lift-explained.png). Offer that ride: the start's wall in
      // the milling direction to where it comes closest to the end's wall, across, and the
      // end's wall in the milling direction into the end. Each wall leg is bounded only by its
      // own loop, as rung (b)(1)'s alternate arc is (an island wrap is legitimately longer than
      // the chord), and the ride meets rung (b)(1)'s proofs: the tool centre stays inside
      // cutRegion, and rideOverloadsUncut at the 1.5x-stepover cap against clearedBeforePass.
      // Offered last, so without the time model it only ever replaces a retract; with it, it
      // is weighed against the lift like every other ride (fix round 4: 240 mm at feed is
      // slower than a 32 mm lift at most feeds, so there the lift wins).
      if (open() && arcs.length === 0) {
        const chain = wallChainInDirection(connStart, connEnd, wallLoops, millingDirection, wallTol)
        const ride: Ride | null = chain ? { points: chain, kind: 'wallfollow' } : null
        const ms = ride ? rideTime(ride) : Infinity
        if (chain && ride && canWin('wall-chain', ride, ms)) {
          if (routeEscapingSegment(chain, cutTree, toolRadius, wallTol) < 0
            && !(exteriorAirDepthAt && routeAirExcursion(chain, exteriorAirDepthAt, toolRadius, wallTol))) {
            const chainOverload = rideOverloadsUncut(chain, clearedBeforePass, toolRadius, cap, arcTol)
            if (!chainOverload) {
              connectionRide = take('wall-chain', ride, ms, () => {
                b8GateStats.routedWallChain++
                // ADR-0003 fail-loud: name the reroute.
                console.warn(`[keepdown-wallchain] endpoints on two different walls -- STAYED DOWN riding both walls ${millingDirection} (${polylineLength(chain).toFixed(1)}mm for a ${chord.toFixed(1)}mm direct move) instead of lifting (WO-2787)`)
              })
            } else {
              liftRecoveryParts.push(`wallchain-overload@(${chainOverload.at.x.toFixed(2)}, ${chainOverload.at.y.toFixed(2)})`)
              note('wall-chain', ride, ms, 'refused', `${chainOverload.width.toFixed(2)}mm sustained > ${cap.toFixed(2)}mm cap near ${at(chainOverload.at)}`)
            }
          } else {
            liftRecoveryParts.push('wallchain-escapes')
            note('wall-chain', ride, ms, 'refused', 'leaves the machinable region or the stock')
          }
        }
      }

      // WO-2787 fix round 4: the timed ladder commits its fastest ride only now, so the
      // counters and fail-loud lines name the ride actually emitted.
      if (timeModel) {
        if (connectionRide && choice.commit) choice.commit()
        else if (weighed.some(c => c.outcome === 'slower')) liftRecoveryParts.push(`lift-fastest(${(liftMs / 1000).toFixed(2)}s)`)
        if (repositionChoiceTrace || timeModel.onChoice) {
          const liftCover = liftCoverMs(timeModel)
          const decided: RepositionChoiceTrace = { passIndex: passes.length, connStart, connEnd, liftMs, candidates: weighed, chosen: connectionRide ? choice.rung : 'lift', clearedBeforePass, cutRegion, ...(liftCover ? { liftCoverMs: liftCover } : {}), ...(forced !== null ? { forced: true as const } : {}) }
          // With a whole-program check listening, it reports the decisions of the program it keeps.
          if (timeModel.onChoice) timeModel.onChoice(decided)
          else repositionChoiceTrace?.(decided)
        }
      }

      // Rung (c): concede the retract. Count a REJECTION only for the gate population -- a
      // primary ride existed and was rejected, and no route-around (arc or chord) recovered it.
      // A primary-null case (endpoints share no wall) that also fails the chord lifts exactly as
      // it did pre-B8 and is NOT a gate rejection, so it is not counted (keeps the Stage 1
      // baseline population meaning intact for the conservation assertions).
      if (!connectionRide && primary && directOverload) {
        b8GateStats.rejections++
        // ADR-0003 fail-loud: name the rejection + position; the substituted lift is legal, but
        // the rejection must never be silent.
        console.warn(`[integral-wallfollow] connection ride REJECTED (B8 engagement gate): sustained effective cut width ${directOverload.width.toFixed(2)}mm > cap ${cap.toFixed(2)}mm over uncleared stock near (${directOverload.at.x.toFixed(2)}, ${directOverload.at.y.toFixed(2)}) [window s=${directOverload.sStart.toFixed(1)}-${directOverload.sEnd.toFixed(1)} of ${directOverload.rideLen.toFixed(1)}mm], and no boundary arc or through-cleared chord is safe -- lifting instead`)
      }
    } else if (jumpType === 2 && !entry && !integralWallFollow) {
      // WO-435 T1 attribution: no recovery tier was even tried (integralWallFollow off).
      liftRecoveryParts.push('integralWallFollow-off')
    }

    // WO-435 T1 attribution: finalize the reason this appendCutPass call will attach to
    // whichever jumpType-2 link it pushes below, now that it is known no tier (wall-follow
    // arc, alternate arc, through-cleared chord) recovered the connection. Untouched when
    // jumpType === 1 (no lift) or when connectionRide recovered it (no lift after all).
    if (strictWallFlow && connectionRide
      && ((!wallRouteKeepsDirection(connectionRide.points, wallLoops, millingDirection, toolRadius * 0.1)
        && (!flowRouteIsRideable(connectionRide.points) || sweepTouchesUncut(connectionRide.points)))
        || routeEscapingSegment(connectionRide.points, cutTree, Math.min(toolRadius, 0.1), 1e-4) >= 0)) {
      connectionRide = null
      liftRecoveryParts.push('3d-wall-flow')
    }
    if (jumpType === 2 && !connectionRide) {
      liftReason = liftRecoveryParts.length > 0 ? `${liftBaseReason}+${liftRecoveryParts.join('+')}` : liftBaseReason
      if (!repositionTime?.trial) keepDownLiftTrace?.({ passIndex: passes.length, connStart, connEnd, liftReason: liftReason!, clearedBeforePass, cutRegion })
    }

    // WO-466: a STOP-SHORT ride is TWO passes, not one -- the at-depth travel (a loopback, at
    // traverse speed) and the engaged tail (a lead, at feed). Pushing every ride through this
    // helper keeps the assembly branches below unaware of the split: a ride with no `feedFrom`
    // is pushed exactly as it always was, so the pre-WO-466 stream is byte-identical.
    //
    // THE FED TAIL IS DELIBERATELY *NOT* FOLDED INTO `cleared`, and that is a measured
    // decision, not an oversight. Folding it -- which is what the tier-0 cut-through does with
    // its own chord -- moves the belief the ENGAGE WALKER reads, and the walker then re-solves
    // every pass after it: measured on gt_fix5 BootL, folding changed the roughing CUT-pass
    // geometry hash (bf3759e8 -> ad943aff, 916 -> 921 passes) for a 3 mm approach stub. This
    // order may not move the roughing path (WO-466: "Do NOT change the roughing path ... every
    // other number identical"), and it does not need to: leaving the tail out UNDER-reports
    // what is cleared, which is the CONSERVATIVE direction on every downstream proof -- a
    // later connection gated against this belief sees material standing where the tail already
    // removed it, so it can only refuse where it would have allowed, never the reverse. The
    // residual is honest-pessimistic by at most one <= 2 x stepover capsule, and the finish
    // site keeps its returned `cleared` untouched for exactly the same reason (WO-449).
    // WO-2787 round 6: the split is ridePasses (repositionTime.ts), the same passes the time
    // model prices the ride as.
    const pushConnectionRide = (ride: { points: Pt[]; kind: 'wallfollow' | 'loopback'; feedFrom?: number }): void => {
      for (const ridePass of ridePasses(ride)) {
        if (ridePass.type === 'loopback') ROUTED_LOOPBACKS.add(ridePass)
        passes.push(ridePass)
      }
    }
    const pushKeepDownLandingApproach = (approach: ClearedLandingApproach): void => {
      if (approach.departure) passes.push({ type: 'lead', points: approach.departure })
      const travelPass: AdaptivePass = { type: 'loopback', points: approach.travel }
      ROUTED_LOOPBACKS.add(travelPass)
      passes.push(travelPass)
      passes.push({ type: 'lead', points: approach.lead })
    }

    // ── Assemble, merging contiguous wall rides and DEDUPing the shared wall ─────────────
    if (exitRide || entryRide) {
      // CLEANUP fired. Three sub-cases for the connection between E and F:
      if (connectionRide) {
        // (i) retract-elimination kept the connection DOWN as a wall ride. The exit cusp, the
        //     connection ride, and the entry cusp are contiguous sub-polylines of the SAME wall,
        //     so MERGE them into one continuous wall-follow A..E..F..B. Dedup the shared joints
        //     (drop the duplicated E and F vertices) so no wall segment is ridden twice.
        if (connectionRide.kind === 'wallfollow') {
          const merged: Pt[] = [
            ...(exitRide ? exitRide.points : [connStart]),
            ...connectionRide.points.slice(1, -1),
            ...(entryRide ? entryRide.points : [connEnd]),
          ]
          const deduped = dedupConsecutive(merged)
          assertInsideCutRegion(deduped, cutTree, wallTol, 'merged wall-follow')
          passes.push({ type: 'wallfollow', points: deduped })
        } else {
          if (exitRide) passes.push({ type: 'wallfollow', points: exitRide.points })
          pushConnectionRide(connectionRide)
          if (entryRide) passes.push({ type: 'wallfollow', points: entryRide.points })
        }
      } else if (jumpType === 1) {
        // (ii) retract-elimination KEPT DOWN as a plain reposition (fast-traverse over cleared:
        //      integralWallFollow off, or on but no shared wall to ride). Tie the cusp rides into
        //      the keep-down traverse with tangent fillets (fillet -> fast-traverse -> fillet), so
        //      the on-wall ride peels smoothly off and back onto the wall. The keep-down DECISION
        //      was already made above by retract-elimination; this only shapes the join. Falls
        //      back to a plain link between the far ends if the fillet build degenerates.
        // WO-1069: buildAcceptedLoopback is buildLoopback plus the contact-stays-on-the-ride
        // acceptance check -- a fit whose contact has slid off a ride's far end comes back with
        // that ride trimmed into a BACKWARD stub, which the direction gate below then rejects,
        // dropping the whole transition onto the kinked straight-link fallback.
        const builtLoopback = (exitRide && entryRide)
          ? buildAcceptedLoopback(exitRide.points, entryRide.points, toolRadius, arcTol, loopbackFilletPct,
              pts => pts.some(p => pointEscapesCutRegion(p, cutTree, wallTol)))
          : null
        // MILLING-DIRECTION GATE ON THE TRIMMED RIDES. These two rides are what the loopback
        // actually emits as wall-follow passes, so they are held to a material-side test like
        // every other wall ride in this file. One rule, one gate: `wallPointsPresentMaterialSide`.
        //
        // WO-1090 (two rounds of measurement, see src/tests/evidence/WO-1090/):
        // - WO-1069 had replaced the probe here with a winding test that accepted 3,932 of
        //   3,932 gate calls over the corpus plus both direction fixtures -- it never rejected,
        //   so the 38 wrong-side rides on the climb fixture came through (the defect
        //   conventional-direction.test.ts caught on main).
        // - Restoring the old single-probe `wallPointsMatchDirection` here (attempt 1) rejected
        //   27 corpus cleanup rides (Kidney 7, Barbell 19, CommaSpiral 1) and moved Operator's
        //   approved corners. Instrumented, every one of those 27 was a sample 1.2-22 um PAST
        //   the wall, inside the keep-out, where BOTH 1e-3 mm side probes read material and the
        //   verdict carried no direction information -- a measurement artifact, not a wrong-side
        //   ride; all 27 run WITH the wall's winding, which is correct for conventional travel.
        // - `wallPointsPresentMaterialSide` reads both probes and, when they cannot separate
        //   the sides, takes the verdict from the nearest wall segment's winding. With it the
        //   nine gt fixtures are byte-identical to the landed WO-1069 baseline (Operator's approved
        //   Kidney/Barbell corners) and the climb fixture's wrong-side rides are rejected.
        //   Wired to THIS call site only; the other three callers ride the cutRegion loop
        //   vertex-by-vertex, where the probe's precondition holds (gate-scope-census.txt).
        const lb = builtLoopback
          && (wallPointsPresentMaterialSide(builtLoopback.exit, cutRegion, millingDirection)
              && wallPointsPresentMaterialSide(builtLoopback.entry, cutRegion, millingDirection))
          ? builtLoopback
          : null
        if (builtLoopback && !lb) {
          if (directionFallback && !directionFallback.rejected) {
            console.warn(
              `[wall-clean] ${millingDirection} loopback trim rejected: material side would invert `
              + '-- retaining the original cusp rides and deferring complete wall cleanup '
              + 'to the final oriented contour',
            )
          }
          if (directionFallback) directionFallback.rejected = true
        }
        // WO-1069 NO-KINK FALLBACK. When no fillet chain is acceptable the old code STILL
        // emitted both cusp rides and then a bare straight link between their FAR ends -- and
        // that link runs back the way the exit ride just came, so the path meets itself at up
        // to 179deg (measured on Kidney pct25: 7 such corners, the worst 179.0/178.1 at
        // (66.65, 33.72)). A ride that cannot be joined tangentially is a ride we should not
        // take: DROP both cusp rides and emit the ordinary keep-down link between the two CUT
        // ends -- exactly the stream wall cleanup produces when it does not fire at all, which
        // is how the milling-direction gate above already defers cleanup. That corridor is a
        // DIFFERENT one from the E->F chord retract-elimination proved, so it is proven here
        // with its own two tests (half-radius corridor vs stock, tool centre inside cutRegion).
        // The stock it is proven against is `clearedBeforePass` -- the PHYSICAL state when this
        // connection executes -- and NOT `cleared`: this link runs BEFORE the new pass cuts, but
        // by the time appendCutPass is called the caller has already folded that pass's swept
        // corridor into `cleared` (see the clearedAtPassStart snapshot comment at the call site).
        // Judging it against `cleared` would certify a keep-down through stock the machine only
        // removes LATER in the same pass -- the same future-state error the B8 gate, the
        // cut-through rung and the lift-recovery rung all avoid by taking clearedBeforePass.
        // If it does not prove, the RIDE+LINK shape stands (WO-1090 rung 2 below) -- but only once
        // that shape's own link has proved itself against the same stock.
        //
        // WO-1090 THE LADDER, ONE RULE, STATED ONCE. WO-1069 shipped rungs (1) and (3) only, and
        // (3) both jumped the queue and skipped the lift-landing gate. Three engine invariants
        // its four-file gate never ran went red on that (gt_two_island took a second retract, the
        // B8 island repro took an UNGATED one that landed on 8.0% uncut stock with no planned
        // descent). The ladder is now:
        //
        //   (1) DROP the rides, keep down on the plain cut-to-cut link -- when that corridor is
        //       both legal and proven clear. Best outcome: no kink, no retract, cleanup deferred
        //       to the final oriented contour exactly as the milling-direction gate above already
        //       defers it.
        //   (2) Else KEEP THE RIDE+LINK SHAPE -- when rung (1)'s objection was LOAD alone and the
        //       E->F link PROVES ITSELF, here, on the same two counts every other keep-down rung
        //       is held to and against the same stock:
        //         (A) finish gouge: the tool centre stays inside the machinable cut-region;
        //         (B) overload: rideOverloadsUncut against clearedBeforePass at the standard
        //             1.5 x stepover cap -- the SAME sustained-width proof tier 1's wallfollow,
        //             loopback and chord rides take, on the PHYSICAL pre-move state, per
        //             GOOD-SPEC section 4's clearedBeforePass discipline.
        //       WO-1090 FIX ROUND: rung (2) originally emitted on (A) alone, on the argument that
        //       retract-elimination had "already proved" E->F when it set jumpType at the top of
        //       phase 2. It had not: that decision tests its corridor against `cleared`, which
        //       already contains the upcoming pass, so it does not establish the pre-move fact
        //       and cannot be inherited. It is proved here or it is not proved. Measured, the
        //       difference is real and not clerical: the B8 island repro's E->F link DOES
        //       sustain-overload uncut stock, so it now takes rung (3)'s GATED retract instead of
        //       an unproven keep-down, while gt_two_island's link proves and stays down.
        //       Why a proven keep-down beats a retract here at all: rung (1) failing is a
        //       statement about the DIFFERENT, shorter cut-to-cut corridor, and a corridor we
        //       never proved cannot retire one that proves itself. The cost is the non-tangent
        //       corner WO-1069 was opened on -- a colinear anti-parallel U-turn whose corner runs
        //       back along the cutter's own just-cut track, the one backtrack AC-SPEC E.3 names
        //       as allowed; the cost of skipping to (3) is a RETRACT, the thing the whole B8
        //       stay-down programme exists to remove.
        //       The narrower "LOAD alone" qualifier is kept deliberately, and it is measured:
        //       offering rung (2) against a cut-to-cut GOUGE as well would be the tidier rule and
        //       it does buy a retract back (Boomerang 4 lifts -> 3, 806 -> 808 passes), but that
        //       is a shape change to an approved fixture baseline and it is not this order's to
        //       make. Recorded here rather than taken.
        //   (3) Else RETRACT -- reached when the cut-to-cut link would GOUGE the finish stock (a
        //       legality failure, not a load one: no straight route between the cut ends exists
        //       at all), or when the E->F link cannot prove itself either. WO-1069 measured this
        //       as the right answer for the single corpus case that reaches it (Boomerang), and
        //       WO-1090 leaves that
        //       measurement standing. What it does not leave standing is the landing: it goes through
        //       gateLiftLanding, the same gate every other lift in this function uses. WO-1069's
        //       claim that a walker point "needs no relocation and no landing gate" is false
        //       whenever wall cleanup has left a standing band around it, which is exactly the
        //       state this branch is reached in.
        const emitRideAndLinkShape = (): void => {
          if (exitRide) { assertInsideCutRegion(exitRide.points, cutTree, wallTol, 'cusp exit'); passes.push({ type: 'wallfollow', points: exitRide.points }) }
          passes.push({ type: 'link', points: [connStart, connEnd], jumpType: 1 })
          if (entryRide) { assertInsideCutRegion(entryRide.points, cutTree, wallTol, 'cusp entry'); passes.push({ type: 'wallfollow', points: entryRide.points }) }
        }
        const emitStraightFallback = (reason: string): void => {
          if (exitRide && entryRide) {
            const where = `near (${connStart.x.toFixed(2)}, ${connStart.y.toFixed(2)})`
            const bareCorridor = capsulePath(lastPoint, nextPoint, toolRadius * 0.5, arcTol)
            const barePlows = totalArea(difference(bareCorridor, clearedBeforePass)) > 1e-6
            const bareGouges = centrePathExitsCutRegion(lastPoint, nextPoint, cutTree, toolRadius)
            if (!barePlows && !bareGouges) {
              console.warn(`[wall-clean] ${reason} ${where} -- dropping the cusp rides, keeping down on the plain link between the cut ends (WO-1069)`)
              passes.push({ type: 'link', points: [lastPoint, nextPoint], jumpType: 1 })
              return
            }
            const unproven = [barePlows ? 'plows uncut' : '', bareGouges ? 'gouges finish' : ''].filter(Boolean).join('/')
            // (2) The ride+link shape, when rung (1)'s objection was LOAD alone and the E->F link
            //     proves itself: no finish gouge, and no sustained overload of the stock that is
            //     physically standing when it runs (clearedBeforePass), at the standard cap.
            const rideLinkGouges = centrePathExitsCutRegion(connStart, connEnd, cutTree, toolRadius)
            const rideLinkOverload = rideLinkGouges
              ? null
              : rideOverloadsUncut([connStart, connEnd], clearedBeforePass, toolRadius, AP.caps.rideCapStepovers * stepOverDistance, arcTol)
            if (!bareGouges && !rideLinkGouges && !rideLinkOverload) {
              console.warn(`[wall-clean] ${reason} ${where} -- ride-free link unproven (${unproven}); keeping the wall rides and the E->F link, which proves clear of gouge and under the 1.5x stepover cap against clearedBeforePass (WO-1090)`)
              emitRideAndLinkShape()
              return
            }
            // (3) No PROVEN keep-down of any shape: RETRACT, landing gated like every other lift.
            const efUnproven = rideLinkGouges
              ? 'the E->F link gouges finish'
              : rideLinkOverload
                ? `the E->F link sustains ${rideLinkOverload.width.toFixed(3)}mm over the ${(AP.caps.rideCapStepovers * stepOverDistance).toFixed(3)}mm cap at (${rideLinkOverload.at.x.toFixed(2)}, ${rideLinkOverload.at.y.toFixed(2)})`
                : 'no keep-down shape is offered against a finish gouge on the cut-to-cut corridor'
            const liftReasonText = `wall-clean-unjoinable@(${connStart.x.toFixed(1)}, ${connStart.y.toFixed(1)})`
            console.warn(`[wall-clean] ${reason} ${where} -- ride-free link unproven (${unproven}) and ${efUnproven}; RETRACTING instead of emitting an unproven keep-down (WO-1069/WO-1090)`)
            const landingPlan = gateLiftLanding(lastPoint, nextPoint, points[1] ?? nextPoint)
            cutStartIndex = landingPlan.cutStartIndex ?? 0
            if (landingPlan.keepDownApproach) {
              pushKeepDownLandingApproach(landingPlan.keepDownApproach)
              return
            }
            const unjoinableLift: AdaptivePass = { type: 'link', points: [lastPoint, landingPlan.landing], jumpType: 2 }
            setLiftReason(unjoinableLift, liftReasonText)
            if (landingPlan.helix) unjoinableLift.helixDescent = landingPlan.helix
            if (landingPlan.clearAirLanding) unjoinableLift.clearAirLanding = true
            attachFallbackHelix(unjoinableLift)
            attachMicroLift(unjoinableLift)
            passes.push(unjoinableLift)
            if (landingPlan.lead) passes.push({ type: 'lead', points: landingPlan.lead })
            return
          }
          emitRideAndLinkShape()
        }
        if (lb) {
          const loopbackPts = [...lb.loopback.fillet1, ...lb.loopback.traverse.slice(1), ...lb.loopback.fillet2.slice(1)]
          const allPts = [...lb.exit, ...loopbackPts, ...lb.entry]
          if (!allPts.some(p => pointEscapesCutRegion(p, cutTree, wallTol))) {
            passes.push({ type: 'wallfollow', points: lb.exit })
            passes.push({ type: 'loopback', points: loopbackPts })
            passes.push({ type: 'wallfollow', points: lb.entry })
          } else {
            // Fillet chain escapes the cut region. Fail-loud: the warn names the rejection so
            // an escaped fillet can never pass silently.
            emitStraightFallback('loopback rejected: fillet chain escapes cutRegion')
          }
        } else {
          // No acceptable fillet chain. With both rides present this is the ADR-0003 tripwire
          // path: buildAcceptedLoopback already warned with the failure reason.
          emitStraightFallback(builtLoopback
            ? 'loopback rejected: milling direction would invert'
            : 'loopback build failed (see wallCleanLoop/loopbackFillet warning)')
        }
      } else {
        // (iii) retract-elimination LIFTED (genuine cross-loop / over-a-hole / long gap). Keep
        //       the LOCAL cusp rides at each arc end; the lift sits between their far ends.
        //
        // The lift is planned once (liftAssembly, above): the landing gate, the entry ride's
        // landing check and the micro-lift proof, the same passes the time model priced.
        if (exitRide) { assertInsideCutRegion(exitRide.points, cutTree, wallTol, 'cusp exit'); passes.push({ type: 'wallfollow', points: exitRide.points }) }
        // WO-435 T1: liftReason was finalized above (jumpType === 2 && !connectionRide, the
        // exact condition that puts us in this branch); an absent value here is a genuine
        // attribution gap, named so the test counts it rather than silently passing.
        pushLiftAssembly(liftReason ?? 'unattributed-case-iii-lifted')
      }
    } else if (connectionRide) {
      // CLEANUP off (or not wall-reaching): retract-elimination rode the wall to stay down.
      pushConnectionRide(connectionRide)
    } else {
      // CLEANUP off and no wall ride: the plain base link (keep-down or lift). A lift's
      // landing is gated like every other (a re-seed link -- entry present -- is exempt:
      // emit skips it, the entry owns its own helix/plunge approach).
      // WO-410: the keep-down decision above proves only the HALF-radius core of the link
      // (the FreeCAD retract-elimination test: the endpoints sit on the cut frontier), so
      // a link beside a standing rim can keep down while its full cutter width ploughs
      // that rim (measured here: a 6.8 mm re-seed link reading 93% of a slot). Hold every
      // keep-down link to the ENGAGEMENT GATE'S OWN CAP at full width -- 75% of a slot
      // (0.75 x tool diameter effective width over rideOverloadsUncut's 2 mm window, vs
      // the physical clearedBeforePass): a link the whole-path gate would refuse lifts
      // instead. NOT the 1.5 x stepover ride cap: a stepover link legitimately rides the
      // cut frontier engaging up to ~one tool RADIUS of the next lane (measured under the
      // stepover cap: gt_two_island went 7 -> 61 lifts, a retract storm), and the 3D
      // emitter already pecks any link over 50% of a slot against LIVE stock (WO-409
      // part 2). This gate is the planner's honesty bound, not the load bound.
      // WO-410: a re-seed transition (entry present) gets NO link at all. Every emitter
      // (2D emit, render, 3D rough) already skips a link immediately before an entry --
      // the entry owns its own safe approach -- so the stream used to carry a claimed
      // keep-down feed that no machine ever runs (and whose corridor reads as a
      // full-width plough against the physical stock before the entry's helix opens it).
      // An honest plan does not claim motion it never emits.
      // WO-429: `!entry` is the re-seed exemption ("the entry owns its own safe
      // approach"). It is only true when the entry actually opens THIS cut; a stale
      // entry (emitted above) leaves an ordinary connection that must be linked and
      // gated like any other, from the entry point.
      if (!entry || staleEntry) {
        let effectiveJumpType: 1 | 2 = jumpType
        if (jumpType === 1) {
          const cap = AP.caps.slotCeilingDiameters * (2 * toolRadius)
          const overload = rideOverloadsUncut([lastPoint, nextPoint], clearedBeforePass, toolRadius, cap, arcTol)
          if (overload) {
            effectiveJumpType = 2
            // WO-435 T1: this is a DIFFERENT mechanism than the plow/gouge base reason above
            // (jumpType started at 1, a legitimate keep-down candidate) -- name it distinctly.
            liftReason = `keepdown-overload@(${overload.at.x.toFixed(1)}, ${overload.at.y.toFixed(1)}) w=${overload.width.toFixed(2)}>cap=${cap.toFixed(2)}`
            console.warn(`[keep-down] link (${lastPoint.x.toFixed(2)}, ${lastPoint.y.toFixed(2)}) -> (${nextPoint.x.toFixed(2)}, ${nextPoint.y.toFixed(2)}) would plough ${overload.width.toFixed(2)}mm sustained effective width > cap ${cap.toFixed(2)}mm near (${overload.at.x.toFixed(2)}, ${overload.at.y.toFixed(2)}) -- lifting instead (WO-410)`)
          }
        }
        if (effectiveJumpType === 2) {
          // WO-435 T1: jumpType 1 -> 2 here is either the keepdown-overload gate just above
          // (liftReason set inline) or the connection was already jumpType 2 coming in, whose
          // reason was finalized earlier (jumpType === 2 && !connectionRide). An absent value
          // is a genuine attribution gap, named so the test counts it.
          pushLiftAssembly(liftReason ?? 'unattributed-plain-link')
        } else {
          cutStartIndex = 0
          const link: AdaptivePass = { type: 'link', points: [lastPoint, nextPoint], jumpType: effectiveJumpType }
          if (boundarySpan) link.boundarySpan = boundarySpan // Phase A: inert, does not affect emit
          passes.push(link)
        }
      }
    }
    } // end if (!cutThroughEmitted) -- WO-436 tier 0
    } // end if (!throughEmitted) -- WO-1178 through wall ride
  }
  if (entry && !entryEmitted) {
    passes.push({
      type: 'entry',
      point: entry.point,
      ...(entry.clearPoint ? { clearPoint: entry.clearPoint } : {}),
      radius: entry.radius,
      mode: entry.mode,
    })
  }
  passes.push(...emittedCutPasses(cutStartIndex, cutStartIndex > 0 ? lastLeadEnd(passes) : undefined))
  return cleared
}

/** Drop consecutive duplicate points (within eps) so a merged wall-follow does not ride the
 *  same vertex twice at a join (the cusp ride's far end coincides with the connection ride's
 *  first interior vertex after the slice). Keeps the first occurrence. */
function dedupConsecutive(pts: Pt[], eps = 1e-7): Pt[] {
  if (pts.length < 2) return pts
  const out: Pt[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], q = out[out.length - 1]
    if (Math.hypot(p.x - q.x, p.y - q.y) > eps) out.push(p)
  }
  return out
}

/** ADR-0003 fail-loud assert: every point of an emitted wall-clean ride must lie inside-or-on
 *  cutRegion. A ride is built as a true sub-polyline of a cutRegion loop so this can only trip
 *  on a genuine geometry/logic defect -- surface it loudly rather than ship bad motion. */
function assertInsideCutRegion(pts: Pt[], cutTree: PolyNode[], tol: number, label: string): void {
  for (const p of pts) {
    if (pointEscapesCutRegion(p, cutTree, tol)) {
      throw new Error(`[wall-clean] ${label}: point (${p.x.toFixed(3)}, ${p.y.toFixed(3)}) escaped cutRegion (ADR-0003)`)
    }
  }
}

/** True if `p` lies OUTSIDE the machinable cut-region by more than `tol`. Wall-clean rides sit
 *  ON the cutRegion boundary, where a ray-cast can read "outside" by a hair of float error, so
 *  a bare isOutsideCutRegion would false-positive; we only flag a genuine escape -- outside AND
 *  farther than `tol` from the nearest cutRegion edge. Used by the ADR-0003 fail-loud assert. */
function pointEscapesCutRegion(p: Pt, cutTree: PolyNode[], tol: number): boolean {
  if (!isOutsideCutRegion(p, cutTree)) return false
  return distToTree(p, cutTree) > tol
}

/** Min distance from p to any contour edge in the cut tree (roots + their island children). */
function distToTree(p: Pt, cutTree: PolyNode[]): number {
  let best = Infinity
  // WO-3024: the same per-edge distance, over only the edges the grid cannot rule out.
  const measure = (loop: Loop) => {
    visitNearEdges(p, loop, () => best * best, i => {
      const a = loop[i], b = loop[(i + 1) % loop.length]
      const abx = b.x - a.x, aby = b.y - a.y
      const L2 = abx * abx + aby * aby
      let t = L2 > 1e-12 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / L2 : 0
      t = Math.max(0, Math.min(1, t))
      const dx = p.x - (a.x + abx * t), dy = p.y - (a.y + aby * t)
      const d = Math.hypot(dx, dy)
      if (d < best) best = d
    })
  }
  for (const node of cutTree) { measure(node.contour); for (const h of node.children) measure(h.contour) }
  return best
}

/** True if the tool-centre travel from a->b leaves the machinable cut-region anywhere in
 *  its interior (endpoints excluded -- they may sit exactly on the cut frontier). A link
 *  whose centre exits the cut-region would drive the tool edge into the wall / island
 *  finish-stock band, so it must lift instead of keeping down. */
function centrePathExitsCutRegion(a: Pt, b: Pt, cutTree: PolyNode[], toolRadius: number): boolean {
  const d = Math.hypot(b.x - a.x, b.y - a.y)
  if (d < 1e-9) return false
  const n = Math.max(2, Math.ceil(d / (toolRadius * 0.5)))
  for (let i = 1; i < n; i++) {
    const t = i / n
    if (isOutsideCutRegion({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, cutTree)) return true
  }
  return false
}

/** WO-438: index of the first segment of `route` whose tool-CENTRE travel leaves the
 *  machinable cut-region, or -1 when none does. Uses the SAME wall tolerance the engine's
 *  other at-depth rides are held to (`pointEscapesCutRegion`, as the wall-clean loopback and
 *  the merged wall-follow assertion use it) rather than the tolerance-free sample test the
 *  straight-chord gouge check uses: a routed ride starts and ends ON the cut frontier, where a
 *  tolerance-free in/out test reads floating-point boundary contact as an escape. It is the
 *  existing tolerance, not a new allowance -- a genuine excursion into the finish-stock band
 *  is still an escape. */
function routeEscapingSegment(route: Pt[], cutTree: PolyNode[], toolRadius: number, tol: number): number {
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i]
    const d = Math.hypot(b.x - a.x, b.y - a.y)
    if (d < 1e-9) continue
    const n = Math.max(2, Math.ceil(d / (toolRadius * 0.5)))
    for (let k = 1; k < n; k++) {
      const t = k / n
      if (pointEscapesCutRegion({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, cutTree, tol)) return i
    }
  }
  return -1
}

/** WO-1194: how far a tool-centre point stands INSIDE the caller's EXTERIOR AIR -- 0 when it
 *  stands on stock. `params.clearedSeed` IS that air: the 3D rougher builds it from the real
 *  stock footprint (buildSideEntrySeed) and hands it in so the stock edge is not mistaken for
 *  a model wall. It is therefore the engine's ONLY honest answer to "is this point off the
 *  stock" -- the cutRegion cannot answer it, because the same caller deliberately dilates the
 *  region past the stock edge (reachStockEdgeBy) so the cutter centre may stand outside and
 *  feed in. Absent a seed the engine has no separate stock belief and this is not built at
 *  all, so every gate below is dormant and the pass stream is byte-identical.
 *
 *  Depth is the distance to the nearest seed edge, which for a point near the stock edge IS
 *  the stock ring. Where a farther edge (the seed's own big box) is nearer, the answer only
 *  UNDER-states the depth -- the gate errs toward allowing the ride, never toward refusing a
 *  legal one. */
export function exteriorAirDepth(seed: Loops): (p: Pt) => number {
  return (p: Pt): number => {
    // Even-odd: the seed is a big box with the stock footprint punched out of it, so a point
    // is in air when an ODD number of its loops contain it.
    let inside = false
    for (const loop of seed) if (pip2(p, loop) === 1) inside = !inside
    if (!inside) return 0
    let best = Infinity
    for (const loop of seed) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length]
        const abx = b.x - a.x, aby = b.y - a.y
        const L2 = abx * abx + aby * aby
        let t = L2 > 1e-12 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / L2 : 0
        t = Math.max(0, Math.min(1, t))
        const d = Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t))
        if (d < best) best = d
      }
    }
    return Number.isFinite(best) ? best : 0
  }
}

/** WO-1194: the DEEPEST point at which `route` rides further into the exterior air than its
 *  own two endpoints already stand, or null when it never does.
 *
 *  THE BOUND IS THE ROUTE'S OWN ENDPOINTS, not a chosen number. A keep-down ride begins where
 *  the last cut ended and ends on the next pass's engage point -- both are cutting geometry,
 *  and on a stock-edge pass they legitimately stand a little way off the stock (the caller
 *  dilated the region exactly so they could). A ride that goes NO FURTHER OUT than the cutting
 *  it joins is honest; one that leaves the stock to swing round through air is the WO-1194
 *  defect -- 3.04 mm of air on Operator's file, an 11.1 mm out-and-back apex at cutting feed over
 *  ground that has nothing to cut. Air passes `rideOverloadsUncut` trivially (no material to
 *  overload), which is precisely why that proof cannot catch this and this one must.
 *
 *  `tol` is the SAME wall tolerance routeEscapingSegment is held to -- an existing tolerance
 *  for boundary float error, not a new allowance. Interior VERTICES are tested as well as
 *  interior samples: the apex of a perpendicular detour is a vertex, and it is the point the
 *  whole gate exists to see. */
export function routeAirExcursion(
  route: Pt[],
  airDepth: (p: Pt) => number,
  toolRadius: number,
  tol: number,
): { at: Pt; depth: number; allowance: number } | null {
  if (route.length < 2) return null
  const allowance = Math.max(airDepth(route[0]), airDepth(route[route.length - 1])) + tol
  let worst: { at: Pt; depth: number; allowance: number } | null = null
  const consider = (p: Pt): void => {
    const depth = airDepth(p)
    if (depth <= allowance) return
    if (!worst || depth > worst.depth) worst = { at: p, depth, allowance }
  }
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i]
    if (i < route.length - 1) consider(b)
    const d = Math.hypot(b.x - a.x, b.y - a.y)
    if (d < 1e-9) continue
    const n = Math.max(2, Math.ceil(d / (toolRadius * 0.5)))
    for (let k = 1; k < n; k++) {
      const t = k / n
      consider({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    }
  }
  return worst
}

/** WO-438: a connectivity graph over the ground the cutter has ALREADY SWEPT.
 *
 *  Nodes are samples of the emitted CUT tracks (and each region entry's clear point). Two
 *  kinds of edge:
 *   - ALONG-TRACK, between consecutive samples of the same cut pass. Cleared BY CONSTRUCTION:
 *     the cutter travelled exactly there, so riding it backward is the designed loopback
 *     recovery (AC-SPEC E.3, R3 "loopback/reposition may travel backward THROUGH CLEARED
 *     stock ... the CUT never reverses").
 *   - CROSS-TRACK, between samples of DIFFERENT passes that lie within one tool radius of each
 *     other. Adjacent passes overlap by construction (R2 caps the inter-pass gap at one
 *     stepover, which is under a tool radius on every supported setting), so such a hop stays
 *     inside the union of the two swept corridors.
 *
 *  Reachability in this graph is the SAME-CONNECTED-CLEARED-REGION test: if no path exists,
 *  the two points are not joined through swept stock and a tier-3 flight is the honest answer.
 *  Nothing here is trusted blindly -- the caller still proves the chosen ride at full tool
 *  width against the physical pre-move state before keeping it down. */
interface ClearedTrackGraph {
  nodes: Pt[]
  /** Node indices whose point lies within `radius` of `p`. */
  near(p: Pt, radius: number): number[]
  /** Stable key for the undirected edge (i,j), for the caller's ban set. */
  edgeKey(i: number, j: number): number
  /** Expand a node path back to FULL-RESOLUTION motion: every along-track edge becomes the
   *  cut pass's own points between those two samples (so the ride is literally the track the
   *  cutter swept, not a chord across it -- chords cut corners, and at traverse speed a
   *  corner-cutting chord is the difference between a proven-clear ride and a shaving one).
   *  Cross-track hops stay the straight short segment they are. */
  expand(path: number[]): Pt[]
  /** Shortest ride from `from` (entering the graph at any of `sources`) to `to` (leaving at
   *  any of `sinks`), total length bounded by `maxLength`, skipping banned edges. Returns the
   *  node indices in ride order, or null when no ride inside the budget exists. */
  shortestPath(from: Pt, sources: number[], to: Pt, sinks: Set<number>, maxLength: number, banned: Set<number>): number[] | null
}

export function buildClearedTrackGraph(passes: AdaptivePass[], toolRadius: number, stepOverDistance: number, cutTree: PolyNode[], wallTol: number): ClearedTrackGraph | null {
  const spacing = Math.max(toolRadius * 0.75, 1e-3)
  const hop = Math.max(toolRadius, stepOverDistance)
  const nodes: Pt[] = []
  const adjTo: number[][] = []
  const adjW: number[][] = []
  // Provenance of each node, so an along-track edge can be expanded back to the cut pass's
  // own points. -1/-1 for an entry's clear point (it belongs to no track).
  const nodePass: number[] = []
  const nodeIdx: number[] = []
  // Distance along the original cut track, matching expand's full-resolution replay.
  const nodeDistance: number[] = []
  const trackPoints: Pt[][] = []
  const addNode = (p: Pt, track: number, idx: number, distance = 0): number => {
    nodes.push({ x: p.x, y: p.y }); adjTo.push([]); adjW.push([])
    nodePass.push(track); nodeIdx.push(idx); nodeDistance.push(distance)
    return nodes.length - 1
  }
  const link = (i: number, j: number, weight: number): void => {
    adjTo[i].push(j); adjW[i].push(weight)
    adjTo[j].push(i); adjW[j].push(weight)
  }
  for (const pass of passes) {
    if (pass.type === 'entry') { addNode(pass.clearPoint ?? pass.point, -1, -1); continue }
    if (pass.type !== 'cut' || pass.points.length === 0) continue
    const track = trackPoints.length
    trackPoints.push(pass.points)
    let prevNode = addNode(pass.points[0], track, 0)
    let acc = 0
    let distance = 0
    for (let i = 1; i < pass.points.length; i++) {
      const segment = Math.hypot(pass.points[i].x - pass.points[i - 1].x, pass.points[i].y - pass.points[i - 1].y)
      acc += segment
      distance += segment
      if (acc >= spacing || i === pass.points.length - 1) {
        if (acc < 1e-9) continue
        const node = addNode(pass.points[i], track, i, distance)
        link(prevNode, node, acc)
        prevNode = node
        acc = 0
      }
    }
  }
  if (nodes.length < 2) return null

  // Uniform grid for the cross-track hops and for the caller's entry/exit lookups.
  const cell = hop
  const grid = new Map<number, number[]>()
  const key = (cx: number, cy: number): number => cx * 73856093 ^ cy * 19349663
  for (let i = 0; i < nodes.length; i++) {
    const k = key(Math.floor(nodes[i].x / cell), Math.floor(nodes[i].y / cell))
    const bucket = grid.get(k)
    if (bucket) bucket.push(i); else grid.set(k, [i])
  }
  const inRadius = (p: Pt, radius: number): number[] => {
    const out: number[] = []
    const r = Math.ceil(radius / cell)
    const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell)
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const bucket = grid.get(key(cx + dx, cy + dy))
        if (!bucket) continue
        for (const i of bucket) {
          if (Math.hypot(nodes[i].x - p.x, nodes[i].y - p.y) <= radius) out.push(i)
        }
      }
    }
    return out
  }
  // Cross-track hops between neighbouring passes. Screened ONCE, here, against the machinable
  // region: two passes that run within a tool radius of each other on OPPOSITE sides of a thin
  // rib or island are near in space and unreachable in fact, and an unscreened hop across that
  // wall would put a gouging edge into every route the search then has to reject one at a time.
  for (let i = 0; i < nodes.length; i++) {
    for (const j of inRadius(nodes[i], hop)) {
      if (j <= i) continue
      if (adjTo[i].includes(j)) continue
      if (routeEscapingSegment([nodes[i], nodes[j]], cutTree, toolRadius, wallTol) >= 0) continue
      // WO-2937: spatial neighbours can be nonconsecutive samples of the SAME pass
      // (including a wrap back near its seam). expand replays that entire track range,
      // in either orientation, so charging the short chord hides the actual detour.
      // Dijkstra must price the motion it will emit, before selecting a budgeted route;
      // otherwise an underpriced over-budget replay can mask an available legal route.
      const weight = nodePass[i] >= 0 && nodePass[i] === nodePass[j]
        ? Math.abs(nodeDistance[j] - nodeDistance[i])
        : Math.hypot(nodes[j].x - nodes[i].x, nodes[j].y - nodes[i].y)
      link(i, j, weight)
    }
  }

  const edgeKey = (i: number, j: number): number => (i < j ? i * 1000003 + j : j * 1000003 + i)

  const expand = (path: number[]): Pt[] => {
    const out: Pt[] = []
    const push = (p: Pt): void => {
      const last = out[out.length - 1]
      if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-9) out.push({ x: p.x, y: p.y })
    }
    for (let k = 0; k < path.length; k++) {
      const cur = path[k]
      if (k === 0) { push(nodes[cur]); continue }
      const prev = path[k - 1]
      // Along-track edge: replay the cut pass's OWN points between the two samples, forward or
      // backward (a backward ride is the designed loopback -- travel, never a cut).
      if (nodePass[prev] >= 0 && nodePass[prev] === nodePass[cur]) {
        const pts = trackPoints[nodePass[prev]]
        const a = nodeIdx[prev], b = nodeIdx[cur]
        if (a < b) { for (let i = a + 1; i <= b; i++) push(pts[i]) }
        else { for (let i = a - 1; i >= b; i--) push(pts[i]) }
        continue
      }
      push(nodes[cur])
    }
    return out
  }

  const shortestPath = (from: Pt, sources: number[], to: Pt, sinks: Set<number>, maxLength: number, banned: Set<number>): number[] | null => {
    const best = new Map<number, number>()
    const prev = new Map<number, number>()
    // Binary heap of [cost, node].
    const heap: { c: number; n: number }[] = []
    const push = (c: number, n: number): void => {
      heap.push({ c, n })
      let i = heap.length - 1
      while (i > 0) {
        const parent = (i - 1) >> 1
        if (heap[parent].c <= heap[i].c) break
        const t = heap[parent]; heap[parent] = heap[i]; heap[i] = t
        i = parent
      }
    }
    const pop = (): { c: number; n: number } | undefined => {
      if (heap.length === 0) return undefined
      const top = heap[0]
      const last = heap.pop()!
      if (heap.length > 0) {
        heap[0] = last
        let i = 0
        for (;;) {
          const l = 2 * i + 1, r = l + 1
          let m = i
          if (l < heap.length && heap[l].c < heap[m].c) m = l
          if (r < heap.length && heap[r].c < heap[m].c) m = r
          if (m === i) break
          const t = heap[m]; heap[m] = heap[i]; heap[i] = t
          i = m
        }
      }
      return top
    }
    for (const s of sources) {
      const c = Math.hypot(nodes[s].x - from.x, nodes[s].y - from.y)
      if (c > maxLength) continue
      if ((best.get(s) ?? Infinity) <= c) continue
      best.set(s, c); push(c, s)
    }
    let goal = -1
    let goalCost = Infinity
    while (heap.length > 0) {
      const top = pop()!
      if (top.c > (best.get(top.n) ?? Infinity)) continue
      if (top.c > maxLength || top.c >= goalCost) break
      if (sinks.has(top.n)) {
        const total = top.c + Math.hypot(nodes[top.n].x - to.x, nodes[top.n].y - to.y)
        if (total < goalCost && total <= maxLength) { goalCost = total; goal = top.n }
      }
      const neighbours = adjTo[top.n]
      const weights = adjW[top.n]
      for (let e = 0; e < neighbours.length; e++) {
        const v = neighbours[e]
        if (banned.has(edgeKey(top.n, v))) continue
        const c = top.c + weights[e]
        if (c > maxLength) continue
        if (c >= (best.get(v) ?? Infinity)) continue
        best.set(v, c); prev.set(v, top.n); push(c, v)
      }
    }
    if (goal < 0) return null
    const path: number[] = []
    for (let at: number | undefined = goal; at !== undefined; at = prev.get(at)) {
      path.push(at)
      if (path.length > nodes.length) return null
    }
    return path.reverse()
  }

  return { nodes, near: inRadius, edgeKey, expand, shortestPath }
}

/** WO-2787 rung (b)(6): a keep-down ride from a point on one wall loop to a point on ANOTHER,
 *  riding both walls in the milling direction -- along the start's loop to where it comes
 *  closest to the end's loop, across that gap, then along the end's loop into the end. Null
 *  when the two points do not stand on two different loops, or when a leg has no single
 *  milling-direction arc. The caller proves the ride (cut-region, air, load). */
function wallChainInDirection(a: Pt, b: Pt, loops: Loops, direction: AdaptiveMillingDirection, near: number): Pt[] | null {
  const pa = projectOnLoops(a, loops), pb = projectOnLoops(b, loops)
  if (pa.loop < 0 || pb.loop < 0 || pa.loop === pb.loop || pa.dist > near || pb.dist > near) return null
  const la = loops[pa.loop], lb = loops[pb.loop]
  // Closest approach between the two loops: each loop's vertices projected onto the other.
  let gap = { d: Infinity, from: a, to: b }
  for (const v of la) {
    const q = projectOnLoops(v, [lb]).foot, d = Math.hypot(q.x - v.x, q.y - v.y)
    if (d < gap.d) gap = { d, from: v, to: q }
  }
  for (const v of lb) {
    const p = projectOnLoops(v, [la]).foot, d = Math.hypot(v.x - p.x, v.y - p.y)
    if (d < gap.d) gap = { d, from: p, to: v }
  }
  const leg = (from: Pt, to: Pt, loop: Loop): Pt[] | null => {
    if (Math.hypot(to.x - from.x, to.y - from.y) <= near) return [from, to]
    const arcs = boundaryArcsBetween([loop], from, to)
      .filter(arc => wallRouteKeepsDirection(arc, [loop], direction, near))
    return arcs.length === 1 ? arcs[0] : null
  }
  const out = leg(a, gap.from, la)
  const into = leg(gap.to, b, lb)
  return out && into ? dedupConsecutive([...out, ...into]) : null
}

/** WO-3037 (switch keepDownLinksSmooth, default OFF): where a kept-down TRAVEL ride meets
 *  stock the pre-move belief still holds standing -- null when it meets none. The traverse cap
 *  (traverseKeepDownCap) is an AVERAGE over a 2 mm window, so a ride that slides along an uncut
 *  wall rim narrower than the cap passes it the whole way: on the 2D H-pocket a routed ride ran
 *  21 mm down the x = 76.98 wall at fast-traverse rate through the rim the next pass was about to
 *  cut (src/tests/evidence/WO-3037/). This test is zero-width instead: any piece of the ride's
 *  full-radius sweep that the belief has not cleared and that is wider than the faceting artifact
 *  (inscribed radius > arcTol, sweepTouchesUncut's own rule) is standing stock. The one place a
 *  ride may meet stock is the tool's own disk where it ends: that is the bite the next pass takes
 *  from that point, which every keep-down link hands over by construction. */
function rideMeetsStandingStock(route: Pt[], clearedBeforePass: Loops, toolRadius: number, arcTol: number): Pt | null {
  if (route.length < 2) return null
  const sweep = offsetOpenRound(route, toolRadius, arcTol)
  if (sweep.length === 0) return null
  const uncut = difference(difference(sweep, clearedBeforePass), diskPath(route[route.length - 1], toolRadius + arcTol, arcTol))
  if (uncut.length === 0) return null
  const step = Math.max(arcTol, 0.01)
  if (maxInscribedRadius(uncut, toolRadius, step) <= arcTol) return null
  const core = offsetClosed(uncut, -arcTol)
  return centroid(core.length > 0 ? core[0] : uncut[0])
}

/** WO-3068: halvings of the gap between a refused and a proven step -- a bowed hop's sagitta, a
 *  routed ride's corner-round share. Six take the widest sagitta gap (25% -> 40% of the chord) to
 *  0.23% of the chord, ~0.04 mm on a 16 mm hop. */
const BOWED_HOP_REFINE_STEPS = 6

/** WO-3037: the circular arc from `a` to `b` whose sagitta is `h`, bulging to the LEFT of a->b
 *  when side = 1 and to the right when side = -1, sampled so no chord strays more than arcTol/2
 *  from the arc. Its two end tangents turn half its sweep, 2 atan(2h / chord), off the chord. */
function bowedHop(a: Pt, b: Pt, h: number, side: 1 | -1, arcTol: number): Pt[] {
  const c = Math.hypot(b.x - a.x, b.y - a.y)
  const ux = (b.x - a.x) / c, uy = (b.y - a.y) / c
  const R = (c * c / 4 + h * h) / (2 * h)
  // The centre sits on the far side of the chord from the bulge.
  const cx = (a.x + b.x) / 2 - side * uy * -(R - h), cy = (a.y + b.y) / 2 + side * ux * -(R - h)
  const a0 = Math.atan2(a.y - cy, a.x - cx)
  // Callers keep h under half the chord, so this is the minor arc.
  const total = 2 * Math.asin(Math.min(1, c / (2 * R)))
  const maxStep = 2 * Math.acos(Math.max(-1, 1 - Math.max(arcTol, 1e-4) / (2 * R)))
  const n = Math.min(64, Math.max(2, Math.ceil(total / Math.max(maxStep, 1e-3))))
  // Bulging left of a->b means travelling clockwise round the centre.
  const dir = side === 1 ? -1 : 1
  const out: Pt[] = [a]
  for (let k = 1; k < n; k++) {
    const t = a0 + dir * total * k / n
    out.push({ x: cx + R * Math.cos(t), y: cy + R * Math.sin(t) })
  }
  out.push(b)
  return out
}

/** WO-3037: fillet every corner of a kept-down ride that turns by more than `minTurnDeg`, with
 *  the largest round whose tangent points stay inside `share` of each neighbouring segment, so
 *  the rounds never overlap. The rounds cut each corner on its inside; the caller re-proves the
 *  result and keeps the sharp ride when the rounded one does not prove. */
function roundRideCorners(points: Pt[], arcTol: number, share: number, minTurnDeg = 20): Pt[] {
  if (points.length < 3) return points
  const out: Pt[] = [points[0]]
  for (let i = 1; i + 1 < points.length; i++) {
    const p = points[i - 1], q = points[i], r = points[i + 1]
    const l0 = Math.hypot(q.x - p.x, q.y - p.y), l1 = Math.hypot(r.x - q.x, r.y - q.y)
    if (l0 < 1e-9 || l1 < 1e-9) { out.push(q); continue }
    const d0 = { x: (q.x - p.x) / l0, y: (q.y - p.y) / l0 }, d1 = { x: (r.x - q.x) / l1, y: (r.y - q.y) / l1 }
    const cross = d0.x * d1.y - d0.y * d1.x, dot = d0.x * d1.x + d0.y * d1.y
    const turn = Math.atan2(cross, dot) // signed, + = left
    if (Math.abs(turn) * 180 / Math.PI <= minTurnDeg || Math.abs(turn) > Math.PI - 1e-6) { out.push(q); continue }
    const t = share * Math.min(l0, l1)
    const rad = t / Math.tan(Math.abs(turn) / 2)
    const s = { x: q.x - d0.x * t, y: q.y - d0.y * t }
    const sign = turn > 0 ? 1 : -1
    // Centre: a radius in from the first tangent point, on the side the ride turns to.
    const cx = s.x - sign * d0.y * rad, cy = s.y + sign * d0.x * rad
    const a0 = Math.atan2(s.y - cy, s.x - cx)
    const maxStep = 2 * Math.acos(Math.max(-1, 1 - Math.max(arcTol, 1e-4) / (2 * rad)))
    const n = Math.min(32, Math.max(2, Math.ceil(Math.abs(turn) / Math.max(maxStep, 1e-3))))
    for (let k = 0; k <= n; k++) {
      const a = a0 + turn * k / n
      out.push({ x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) })
    }
  }
  out.push(points[points.length - 1])
  return dedupConsecutive(out, Math.max(arcTol * 0.1, 1e-6))
}

/** WO-438 tier 1, rung (b)(3): a ROUTED keep-down path from `a` to `b` that stays at depth
 *  over PROVEN-cleared stock when neither boundary arc nor the direct chord does.
 *
 *  This is the port of the ancestor's `ResolveLinkPath` (Adaptive.cpp:2791-2904): "starting
 *  from a queue of (start,end) point pairs, it repeatedly tries the direct segment; if
 *  blocked, it perturbs perpendicular to the direct line by increasing offsets looking for a
 *  clear alternate route", bounded by a point budget and by `keepToolDownDistRatio x
 *  directDistance`. Two candidate families are offered, and the SHORTEST legal one wins
 *  (cheapest proof first, GOOD-SPEC section 3):
 *
 *   - BACKTRACK along `priorTrack` (AC-SPEC E.3, the designed recovery): the cutter's own
 *     just-cut track is cleared BY CONSTRUCTION, so riding it BACKWARD -- opposite the spiral
 *     sense -- is always legal ground. This is TRAVEL, not a cut (R3: "loopback/reposition may
 *     travel backward THROUGH CLEARED stock ... the CUT never reverses").
 *   - PERPENDICULAR DETOUR around the obstruction, the ancestor's own search shape.
 *
 *  Every candidate is held to the caller's proofs, never a loosened one: the tool CENTRE stays
 *  inside the machinable cut-region on every segment (no finish gouge / island keep-out
 *  crossing), and the whole assembled polyline passes `rideOverloadsUncut` at the `cap` the
 *  caller sets against the PHYSICAL pre-move state. The caller emits the result as a LOOPBACK
 *  (traverse), so that cap is the traverse bound -- far tighter than the cutting-role wall
 *  ride's. A route longer than `maxLength` is rejected outright (the detour budget), which is
 *  why the caller can name 'route-detour>budget' honestly when nothing in budget is legal. */
export function planKeepDownRoute(
  a: Pt,
  b: Pt,
  priorTrack: Pt[] | null,
  priorMotion: Pt[],
  trackGraph: ClearedTrackGraph | null,
  clearedBeforePass: Loops,
  cutTree: PolyNode[],
  toolRadius: number,
  stepOverDistance: number,
  arcTol: number,
  cap: number,
  maxLength: number,
  airDepth: ((p: Pt) => number) | null = null,
  onAcceptedGraphRoute?: AcceptedGraphRouteObserver,
  standing: ((route: Pt[]) => Pt | null) | null = null,
): { points: Pt[]; length: number; family: 'backtrack' | 'detour' | 'via-cleared' } | null {
  const direct = Math.hypot(b.x - a.x, b.y - a.y)
  if (direct <= 1e-9 || !Number.isFinite(maxLength) || maxLength <= 0) return null
  const ux = (b.x - a.x) / direct, uy = (b.y - a.y) / direct
  const nx = -uy, ny = ux

  type RouteFamily = 'backtrack' | 'detour' | 'via-cleared'
  const candidates: { points: Pt[]; length: number; family: RouteFamily }[] = []
  const offer = (waypoints: Pt[], family: RouteFamily): void => {
    const route = dedupConsecutive([a, ...waypoints, b], Math.max(arcTol, 1e-6))
    if (route.length < 3) return // the bare direct chord is the caller's own earlier rung
    const length = polylineLength(route)
    if (length > maxLength) return
    candidates.push({ points: route, length, family })
  }

  // Family 1 -- BACKTRACK along the cutter's own track, walking BACKWARD from its end. Each
  // sample is one candidate: ride the track back that far, then cross to b. Sampled at
  // stepover spacing so the number of candidates does not depend on the pass's point density.
  if (priorTrack && priorTrack.length >= 2) {
    const spacing = Math.max(stepOverDistance, toolRadius * 0.5, arcTol * 4)
    let ridden = 0
    let nextSample = spacing
    const tail: Pt[] = [priorTrack[priorTrack.length - 1]]
    for (let i = priorTrack.length - 2; i >= 0; i--) {
      const p = priorTrack[i], q = priorTrack[i + 1]
      ridden += Math.hypot(q.x - p.x, q.y - p.y)
      tail.push(p)
      if (ridden >= maxLength) break
      if (ridden >= nextSample) {
        offer([...tail], 'backtrack')
        nextSample = ridden + spacing
        if (candidates.length >= 24) break
      }
    }
  }

  // Family 2 -- PERPENDICULAR DETOUR (the ancestor's increasing-offset search). One waypoint
  // at the midpoint, then a two-waypoint U at the thirds, both sides, offsets stepping up.
  const offsets: number[] = []
  for (const k of [1, 2, 3, 4, 6, 8, 12]) {
    const o = k * stepOverDistance
    if (o <= maxLength) offsets.push(o)
  }
  for (const o of offsets) {
    for (const sign of [1, -1]) {
      const mx = a.x + ux * direct * 0.5 + nx * o * sign
      const my = a.y + uy * direct * 0.5 + ny * o * sign
      offer([{ x: mx, y: my }], 'detour')
    }
  }
  for (const o of offsets) {
    for (const sign of [1, -1]) {
      offer([
        { x: a.x + ux * direct / 3 + nx * o * sign, y: a.y + uy * direct / 3 + ny * o * sign },
        { x: a.x + ux * direct * 2 / 3 + nx * o * sign, y: a.y + uy * direct * 2 / 3 + ny * o * sign },
      ], 'detour')
    }
  }

  // Family 3 -- VIA A PROVEN-CLEARED WAYPOINT. Every point of previously emitted cutter-centre
  // motion was swept by the cutter before this connection runs, so it is cleared BY
  // CONSTRUCTION -- the same constructive evidence the lift-landing gate already trusts for
  // its clear-shaft search. Turning through one such point routes around an island or a
  // re-entrant wall that no perpendicular offset of the direct line can clear. Ranked by the
  // resulting route length (cheapest detour first) and thinned so near-duplicate waypoints do
  // not spend the validation budget.
  if (priorMotion.length > 0) {
    const ranked: { p: Pt; len: number }[] = []
    for (const p of priorMotion) {
      const len = Math.hypot(p.x - a.x, p.y - a.y) + Math.hypot(b.x - p.x, b.y - p.y)
      if (len > maxLength) continue
      ranked.push({ p, len })
    }
    ranked.sort((p, q) => p.len - q.len)
    const spread = Math.max(stepOverDistance * 2, toolRadius)
    const picked: Pt[] = []
    for (const { p } of ranked) {
      if (picked.some(q => Math.hypot(q.x - p.x, q.y - p.y) < spread)) continue
      picked.push(p)
      offer([p], 'via-cleared')
      if (picked.length >= 12) break
    }
  }

  // Cheapest detour first. Ties keep insertion order (backtrack before detour) so the
  // DESIGNED recovery wins a tie against a synthetic perpendicular hop.
  candidates.sort((p, q) => p.length - q.length)

  const wallTol = Math.max(arcTol * AP.sampling.wallTolArcTols, toolRadius * AP.sampling.wallTolToolRadii)
  // WO-1194 THE AIR VETO. Every proof above measures a route against MATERIAL, so ground that
  // has no material -- the air outside the stock the caller's exterior seed names -- passes
  // all of them for free. A detour that leaves the stock to swing back in is therefore the one
  // illegal keep-down ride this planner could not see, and it is what Operator photographed. The
  // veto SKIPS the candidate rather than abandoning the search, so the next-cheapest route
  // (the mirrored detour, a via-cleared turn, the cleared-track ride) is still offered and the
  // retract stays the last resort it was. Dormant when no exterior seed was supplied.
  let airWarned = false
  const airExcursion = (route: Pt[]): { at: Pt; depth: number; allowance: number } | null => {
    if (!airDepth) return null
    const hit = routeAirExcursion(route, airDepth, toolRadius, wallTol)
    if (hit && !airWarned) {
      airWarned = true
      // ADR-0003 fail-loud: name the refusal, the measurement and the bound it broke.
      console.warn(`[keepdown-route] air detour REFUSED: route reaches (${hit.at.x.toFixed(2)}, ${hit.at.y.toFixed(2)}), ${hit.depth.toFixed(2)}mm outside the stock, past the ${hit.allowance.toFixed(2)}mm its own endpoints stand out -- searching for a route that stays on stock (WO-1194)`)
    }
    return hit
  }
  let fullChecks = 0
  for (const cand of candidates) {
    if (routeEscapingSegment(cand.points, cutTree, toolRadius, wallTol) >= 0) continue
    if (airExcursion(cand.points)) continue
    if (fullChecks++ >= 16) break // bounded like the ancestor's point/time budget
    if (rideOverloadsUncut(cand.points, clearedBeforePass, toolRadius, cap, arcTol)) continue
    if (standing?.(cand.points)) continue // WO-3037 (switch ON only; null otherwise)
    return cand
  }

  // Family 4 -- THE CLEARED-TRACK GRAPH: route through the region the cutter has actually
  // swept. This is the ancestor's breadth-expanding ResolveLinkPath search given the one piece
  // of evidence our engine owns and FreeCAD's queue search does not: the cutter's OWN TRACKS.
  // Straight chords between distant cleared points keep failing the material proof because the
  // straight line leaves the swept corridor; a path that RIDES the tracks cannot. The graph's
  // along-track edges are cleared BY CONSTRUCTION (the cutter came from there, AC-SPEC E.3),
  // and its cross-track hops are short enough that adjacent passes' corridors overlap (the
  // inter-pass gap is <= one stepover by R2, and the hop radius is a full tool radius). The
  // shortest path through it is the honest at-depth backtrack; it is still held to the same
  // full-width material proof as every other tier-1 rung, and to the same detour budget.
  // GRAPH REACHABILITY IS ALSO THE SAME-CONNECTED-REGION TEST: no path means the two points
  // are not joined through swept stock, which is exactly when a tier-3 flight is honest.
  if (trackGraph && trackGraph.nodes.length > 1) {
    const g = trackGraph
    const hop = Math.max(toolRadius, stepOverDistance) * 2
    const sources = g.near(a, hop)
    const sinks = new Set(g.near(b, hop))
    if (sources.length > 0 && sinks.size > 0) {
      const banned = new Set<number>()
      let liveSources = sources
      for (let attempt = 0; attempt < 8; attempt++) {
        const idx = g.shortestPath(a, liveSources, b, sinks, maxLength, banned)
        if (!idx || idx.length === 0) break
        const route = dedupConsecutive([a, ...g.expand(idx), b], Math.max(arcTol, 1e-6))
        if (route.length < 3) break
        const length = polylineLength(route)
        if (length > maxLength) break
        const escaping = routeEscapingSegment(route, cutTree, toolRadius, wallTol)
        // WO-1194: a track ride is held to the SAME air veto as every candidate above -- and it
        // bans the offending leg exactly as an overload does, so the search keeps going.
        const air = escaping >= 0 ? null : airExcursion(route)
        const trip = escaping >= 0 || air ? null : rideOverloadsUncut(route, clearedBeforePass, toolRadius, cap, arcTol)
        // WO-3037 (switch ON only): a track ride through standing stock bans its leg like an overload.
        const standingHit = escaping >= 0 || air || trip || !standing ? null : standing(route)
        if (escaping < 0 && !air && !trip && !standingHit) {
          // WO-2937: observe only after ALL original physical proofs. Deep-copy
          // only when enabled, so even an untyped observer cannot alter motion.
          onAcceptedGraphRoute?.(Object.freeze({
            points: Object.freeze(route.map(p => Object.freeze({ x: p.x, y: p.y }))),
            length, maxLength,
          }))
          return { points: route, length, family: 'via-cleared' }
        }
        // Where the ride failed, in coordinates. `route` is the EXPANDED motion, so its index
        // no longer maps to a graph edge -- locate the failure geometrically instead and ban
        // whichever leg of the node path owns it, then look for the next-shortest ride.
        const at = trip
          ? trip.at
          : standingHit
            ? standingHit
            : air
            ? air.at
            : { x: (route[escaping - 1].x + route[escaping].x) / 2, y: (route[escaping - 1].y + route[escaping].y) / 2 }
        const distToSeg = (p: Pt, q: Pt): number => {
          const lx = q.x - p.x, ly = q.y - p.y
          const l2 = lx * lx + ly * ly
          const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((at.x - p.x) * lx + (at.y - p.y) * ly) / l2)) : 0
          return Math.hypot(at.x - (p.x + lx * t), at.y - (p.y + ly * t))
        }
        let bestLeg = -1 // 0 = entry leg (a -> first node), idx.length = exit leg, else edge k
        let bestDist = Infinity
        {
          const d0 = distToSeg(a, g.nodes[idx[0]])
          if (d0 < bestDist) { bestDist = d0; bestLeg = 0 }
          for (let k = 1; k < idx.length; k++) {
            const d = distToSeg(g.nodes[idx[k - 1]], g.nodes[idx[k]])
            if (d < bestDist) { bestDist = d; bestLeg = k }
          }
          const dN = distToSeg(g.nodes[idx[idx.length - 1]], b)
          if (dN < bestDist) { bestDist = dN; bestLeg = idx.length }
        }
        let bannedOne = false
        if (bestLeg === 0) {
          liveSources = liveSources.filter(n => n !== idx[0])
          bannedOne = liveSources.length > 0
        } else if (bestLeg === idx.length) {
          sinks.delete(idx[idx.length - 1])
          bannedOne = sinks.size > 0
        } else if (bestLeg > 0) {
          banned.add(g.edgeKey(idx[bestLeg - 1], idx[bestLeg]))
          bannedOne = true
        }
        if (!bannedOne) break
      }
    }
  }

  return null
}

// ── PROTO wall-clean helpers ────────────────────────────────────────────────────

interface LoopProj { dist: number; foot: Pt; loop: number; seg: number }
/** Project `p` onto the nearest edge of any cutRegion loop, returning the foot, the loop
 *  index it lies on, and the segment index within that loop. Mirrors nearestOnLoops in
 *  wallCleanLoop.ts so the SAME-LOOP gate here agrees with the builder's own projection. */
function projectOnLoops(p: Pt, loops: Loops): LoopProj {
  let best: LoopProj = { dist: Infinity, foot: p, loop: -1, seg: -1 }
  for (let li = 0; li < loops.length; li++) {
    const lp = loops[li]
    const grid = lp.length >= SEG_GRID_MIN_SEGMENTS ? segGridOf(lp) : null
    if (grid && p.x >= grid.minX && p.x <= grid.maxX && p.y >= grid.minY && p.y <= grid.maxY) {
      best = projectOnLoopGrid(p, lp, li, grid, best)
      continue
    }
    for (let i = 0; i < lp.length; i++) {
      const proj = projectOnSegment(p, lp, i)
      if (proj.d < best.dist) best = { dist: proj.d, foot: proj.foot, loop: li, seg: i }
    }
  }
  return best
}

/** One edge's projection, the arithmetic projectOnLoops has always used. */
function projectOnSegment(p: Pt, lp: Loop, i: number): { d: number; foot: Pt } {
  const a = lp[i], b = lp[(i + 1) % lp.length]
  const abx = b.x - a.x, aby = b.y - a.y
  const L2 = abx * abx + aby * aby
  let t = L2 > 1e-12 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / L2 : 0
  t = Math.max(0, Math.min(1, t))
  const foot = { x: a.x + abx * t, y: a.y + aby * t }
  return { d: Math.hypot(p.x - foot.x, p.y - foot.y), foot }
}

// WO-3024: a uniform grid over one loop's edges, so projectOnLoops visits only the edges near
// the query instead of every vertex of every loop (30 s self time on the Form cylinder). The
// answer is the linear scan's to the bit: every edge that could be nearest is measured with the
// same arithmetic, and ties go to the lowest edge index, which is what the scan's strict `<`
// keeps. Loops are never mutated after they are built; the length check is a guard.
const SEG_GRID_MIN_SEGMENTS = 64
interface SegGrid { len: number; minX: number; minY: number; maxX: number; maxY: number; cell: number; nx: number; ny: number; cells: number[][] }
const segGrids = new WeakMap<Loop, SegGrid>()
function segGridOf(lp: Loop): SegGrid {
  const cached = segGrids.get(lp)
  if (cached && cached.len === lp.length) return cached
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const q of lp) {
    if (q.x < minX) minX = q.x
    if (q.x > maxX) maxX = q.x
    if (q.y < minY) minY = q.y
    if (q.y > maxY) maxY = q.y
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-6)
  const cell = Math.max(span / Math.ceil(Math.sqrt(lp.length)), 1e-6)
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1)
  const ny = Math.max(1, Math.ceil((maxY - minY) / cell) + 1)
  const cells: number[][] = Array.from({ length: nx * ny }, () => [])
  const cx = (x: number): number => Math.min(nx - 1, Math.max(0, Math.floor((x - minX) / cell)))
  const cy = (y: number): number => Math.min(ny - 1, Math.max(0, Math.floor((y - minY) / cell)))
  for (let i = 0; i < lp.length; i++) {
    const a = lp[i], b = lp[(i + 1) % lp.length]
    const x0 = cx(Math.min(a.x, b.x)), x1 = cx(Math.max(a.x, b.x))
    const y0 = cy(Math.min(a.y, b.y)), y1 = cy(Math.max(a.y, b.y))
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) cells[gy * nx + gx].push(i)
  }
  const grid = { len: lp.length, minX, minY, maxX, maxY, cell, nx, ny, cells }
  segGrids.set(lp, grid)
  return grid
}
/** Rings of cells outward from the query's cell: every edge in ring k lies at least (k - 1)
 *  cells away, so once that bound passes the best distance found, no farther edge can win. */
function projectOnLoopGrid(p: Pt, lp: Loop, li: number, grid: SegGrid, best: LoopProj): LoopProj {
  const { nx, ny, cell, cells } = grid
  const px = Math.min(nx - 1, Math.max(0, Math.floor((p.x - grid.minX) / cell)))
  const py = Math.min(ny - 1, Math.max(0, Math.floor((p.y - grid.minY) / cell)))
  let localD = Infinity, localSeg = -1, localFoot: Pt = p
  const visit = (gx: number, gy: number): void => {
    for (const i of cells[gy * nx + gx]) {
      const proj = projectOnSegment(p, lp, i)
      if (proj.d < localD || (proj.d === localD && i < localSeg)) { localD = proj.d; localSeg = i; localFoot = proj.foot }
    }
  }
  const maxRing = Math.max(nx, ny)
  for (let k = 0; k <= maxRing; k++) {
    if ((k - 1) * cell > Math.min(localD, best.dist) + 1e-9) break
    for (let gx = px - k; gx <= px + k; gx++) {
      if (gx < 0 || gx >= nx) continue
      if (py - k >= 0) visit(gx, py - k)
      if (k > 0 && py + k < ny) visit(gx, py + k)
    }
    for (let gy = py - k + 1; gy <= py + k - 1; gy++) {
      if (gy < 0 || gy >= ny) continue
      if (px - k >= 0) visit(px - k, gy)
      if (k > 0 && px + k < nx) visit(px + k, gy)
    }
  }
  return localSeg >= 0 && localD < best.dist ? { dist: localD, foot: localFoot, loop: li, seg: localSeg } : best
}

/** WO-3024: closestOnSegment's squared distance from `p` to edge g (lp[g] -> lp[g + 1]), the
 *  arithmetic of every `loop[i - 1] -> loop[i]` scan below (i = g + 1). */
function edgeDistSq(p: Pt, lp: Loop, g: number): number {
  return closestOnSegment(lp[g], lp[(g + 1) % lp.length], p).distSq
}
const edgeIsPoint = (lp: Loop, g: number): boolean => {
  const a = lp[g], b = lp[(g + 1) % lp.length]
  return Math.hypot(b.x - a.x, b.y - a.y) <= 1e-9
}
/** Visit the edges of `lp` near `p`, ring by ring, until no farther edge can be within
 *  `limitSq()` (re-read after every ring, so a shrinking best tightens the search). */
function visitNearEdges(p: Pt, lp: Loop, limitSq: () => number, visit: (g: number) => void): void {
  const grid = lp.length >= SEG_GRID_MIN_SEGMENTS ? segGridOf(lp) : null
  if (!grid || p.x < grid.minX || p.x > grid.maxX || p.y < grid.minY || p.y > grid.maxY) {
    for (let g = 0; g < lp.length; g++) visit(g)
    return
  }
  const { nx, ny, cell, cells } = grid
  const px = Math.min(nx - 1, Math.max(0, Math.floor((p.x - grid.minX) / cell)))
  const py = Math.min(ny - 1, Math.max(0, Math.floor((p.y - grid.minY) / cell)))
  const cellAt = (gx: number, gy: number): void => { for (const g of cells[gy * nx + gx]) visit(g) }
  const maxRing = Math.max(nx, ny)
  for (let k = 0; k <= maxRing; k++) {
    const reach = (k - 1) * cell
    if (k > 1 && reach * reach > limitSq() * (1 + 1e-9) + 1e-12) break
    for (let gx = px - k; gx <= px + k; gx++) {
      if (gx < 0 || gx >= nx) continue
      if (py - k >= 0) cellAt(gx, py - k)
      if (k > 0 && py + k < ny) cellAt(gx, py + k)
    }
    for (let gy = py - k + 1; gy <= py + k - 1; gy++) {
      if (gy < 0 || gy >= ny) continue
      if (px - k >= 0) cellAt(px - k, gy)
      if (k > 0 && px + k < nx) cellAt(px + k, gy)
    }
  }
}
/** closestPointOnPaths(loops, p).dist, to the bit: the same per-edge arithmetic, a minimum
 *  over the edges the grid cannot rule out. */
function distToLoops(p: Pt, loops: Loops): number {
  let minSq = Infinity
  for (const lp of loops) visitNearEdges(p, lp, () => minSq, g => { const d = edgeDistSq(p, lp, g); if (d < minSq) minSq = d })
  return Math.sqrt(minSq)
}
/** The edges a `loop[i - 1] -> loop[i]` scan for the nearest non-degenerate edge to `p` could
 *  pick, in that scan's own order (loop by loop, i ascending, so edge g sorts as g + 1, the
 *  closing edge first). Callers run their unchanged scan body over this list. */
function nearestEdgeCandidates(p: Pt, loops: Loops): { lp: Loop; g: number }[] {
  let minSq = Infinity
  for (const lp of loops) visitNearEdges(p, lp, () => minSq, g => { if (edgeIsPoint(lp, g)) return; const d = edgeDistSq(p, lp, g); if (d < minSq) minSq = d })
  const limit = minSq * (1 + 1e-9) + 1e-12
  const out: { lp: Loop; g: number }[] = []
  for (const lp of loops) {
    const found = new Set<number>()
    visitNearEdges(p, lp, () => limit, g => { if (!edgeIsPoint(lp, g) && edgeDistSq(p, lp, g) <= limit) found.add(g) })
    const n = lp.length
    for (const g of [...found].sort((u, v) => (u + 1) % n - (v + 1) % n)) out.push({ lp, g })
  }
  return out
}

/** WO-1178: geom's cleanPath, except that the points in `keep` (a pass's wall-fillet samples)
 *  are always emitted. cleanPath merges a tool-radius arc into 18-degree chords at the path
 *  tolerance (0.025 mm sagitta on a 2 mm radius), and a chord that long meets the wall at
 *  9 degrees -- the kink the fillet exists to remove. Everything else is merged exactly as
 *  cleanPath merges it. */
function cleanPathKeeping(path: Pt[], tolerance: number, keep: Set<Pt>): Pt[] {
  if (keep.size === 0) return cleanPath(path, tolerance)
  const out: Pt[] = []
  for (const pt of path) {
    if (out.length === 0) { out.push(pt); continue }
    if (keep.has(pt) || keep.has(out[out.length - 1])) { out.push(pt); continue }
    if (out.length > 2) {
      const { distSq } = closestOnSegment(out[out.length - 2], out[out.length - 1], pt, false)
      if (Math.sqrt(distSq) < tolerance) { out[out.length - 1] = pt } else { out.push(pt) }
    } else if (magnitude(sub(pt, out[out.length - 1])) < tolerance) {
      out[out.length - 1] = pt
    } else {
      out.push(pt)
    }
  }
  return out
}

function lastCut(passes: AdaptivePass[]): { type: 'cut'; points: Pt[] } | null {
  for (let i = passes.length - 1; i >= 0; i--) if (passes[i].type === 'cut') return passes[i] as { type: 'cut'; points: Pt[] }
  return null
}

/** WO-449: where the tool PHYSICALLY IS at the end of the stream so far -- across every pass
 *  kind, not just 'cut'. A wall-finish connection departs from the last emitted motion of any
 *  role (a wall ride, a loopback, a gap fill), which lastCut cannot see. */
function lastEmittedPoint(passes: AdaptivePass[]): Pt | null {
  for (let i = passes.length - 1; i >= 0; i--) {
    const p = passes[i]
    if (p.type === 'entry') return p.point
    if (p.type === 'link') return p.points[1]
    if (p.points.length > 0) return p.points[p.points.length - 1]
  }
  return null
}
