// cam3d L4: AdaptiveRoughStrategy -- per-Z-level 3D adaptive rougher.
//
// Recipe (stage A2), built on the stage-A1 region core (src/cam3d/rough):
//   1. Build a full-box stock ZDexelField and, aligned to its grid, a part
//      top-surface heightfield (buildPartHeightField).
//   2. Plan even top-down Z levels (planLevels) from the stock top to a floor.
//   3. Discover each stock-aware Z-level on a private top-down replay, decompose
//      it into bounded components, and run the READ-ONLY 2D adaptive engine.
//   4. Link adjacent components by positive-area XY overlap and emit one
//      independent branch through depth before relocating to a sibling branch.
//      Every emitted move still updates and validates against the real live
//      stock field.
//
// LAYERING: consumes the L2 GeometryKernel surface (via buildPartHeightField),
// the L3 stock/geom2d services, and the 2D engine READ-ONLY. It never mutates
// or imports the 2D engine's internals beyond its documented entry points
// (processFeature + ensureEngineClipperReady).
//
// RADIAL STOCK-TO-LEAVE OWNERSHIP (interface fact, proven by Gate A no-gouge):
// the radial finish skin is applied EXACTLY ONCE, by cutRegionAt (it grows the
// part section outward by radialStockToLeave before the stock/part difference).
// processFeature is therefore called with stockToLeave: 0. processFeature still
// insets the region inward by (toolRadius + tolerance/2) -- toolRadius keeps the
// tool CENTRE inside the wall (a separate concern from finish stock), and the
// tolerance/2 is the engine's own arc-fit margin. Passing our radialStockToLeave
// to processFeature as well would inset by it a SECOND time (double skin); the
// no-gouge gate confirms exactly-once application.
//
// DETERMINISM (D-006): exact overlap dependencies, stable nearest tie-breaks,
// processFeature, and emit are deterministic; no RNG/time.

import type { CutterSpec, GeometryKernel, MeshHandle } from '../kernel/types';
import type {
  AdaptiveRoughDiagnostics,
  AdaptiveRoughRegionBounds,
  OperationDiagnostics,
} from '../../types';
import { area, boolean, ensureGeom2dReady, offset, type Ring } from '../geom2d';
import { ZDexelField, remainingAbove, type Box3, type GridFrame } from '../stock';
import type { ToolpathIR, IrMove } from '../ir/types';
import type { AdaptiveMillingDirection } from '../../lib/cam/types';
import type { Cam3dProgressCallback, Cam3dProgressTiming } from '../progress';
import {
  buildPartHeightField,
  frameOf,
  planLevels,
  findCriticalDepths,
  cutRegionAt,
  decomposeToComponents,
  measurePathEngagement,
  type RegionComponent,
} from '../rough';
import { featureFromComponent } from '../rough/feature';
import { planWithProgress } from '../rough/plannerProgress';
import { buildSideEntrySeed } from '../rough/sideSeed';
import {
  ExactAdaptiveLevelPlanCache,
  exactAdaptiveRequestKey,
  type AdaptiveLevelPlanRequest,
  type AdaptivePlannerPool,
} from '../rough/adaptivePlanCache';
import { emitLevelPasses, type EmitContext } from '../rough/emit';
import { modelPartSection, partSectionNeedsModelLocation, pointInRing } from '../rough/cutRegion';
import {
  directionForClockwisePlanner,
  type SpindleRotation,
} from '../rough/millingDirection';
import { smoothAdaptiveIr } from '../rough/smoothPath';
import { planWallCleanup } from '../rough/wallCleanup';
import { orderAdaptiveComponents } from '../rough/orderComponents';
import {
  scheduleAdaptiveDepthBranches,
  scheduleAdaptiveDepthBranchesWithTerraces,
  type AdaptiveTerraceCandidate,
  type AdaptiveDepthComponentPlan,
} from '../rough/scheduleComponents';
import { terraceIntervals } from '../rough/terraceSchedule';
import {
  measureTerraceRemoval,
  terraceRemovalIsProductive,
} from '../rough/terraceMaterial';
import { replayMovesIntoStock, type ToolTipPosition } from '../rough/replayStock';
import {
  enforceTraverseSafety,
  mergeWorstIntrusion,
  type WorstIntrusion,
} from '../rough/traverseSafety';
import {
  processFeature,
  ensureEngineClipperReady,
  type AdaptivePass,
  type FeatureResult,
  type ProcessParams,
} from '../rough/engineEntry';

declare module '../../types' {
  interface AdaptiveRoughDiagnostics {
    /** Candidate regions erased by the cutter-radius offset. */
    cutterErasedRegions?: number;
    /** Exact operation-local XY planner cache accounting. */
    plannerCacheHits?: number;
    plannerCacheMisses?: number;
    plannerUniquePlans?: number;
    /** Actual geometry-dependent component execution order. */
    componentSchedule?: Array<{
      order: number;
      levelIndex: number;
      componentIndex: number;
      z: number;
    }>;
    terraceCandidates?: number;
    terraceEmitted?: number;
    terraceSkipped?: number;
    terraceConservativeFallbacks?: number;
    terraceRemovedVolumeMm3?: number;
    terraceChangedAreaMm2?: number;
  }
}

export interface AdaptiveRoughInput {
  /** Mesh handle previously uploaded to the SAME kernel. */
  mesh: MeshHandle;
  /** Cutter: flat or ball (removeSweep/engagementAt support these only). */
  cutter: CutterSpec;
  /** Stock box to build the ZDexelField from. */
  stockBounds: Box3;
  /** Requested stock/part grid cell size, mm. */
  cellSize: number;
  /** Max axial depth of cut per level, mm (deep default OK: engagement is
   *  bounded by the 2D engine in plan view, not by the stepdown). */
  maxStepdown: number;
  /**
   * Clear the curved-wall terrace halfway between consecutive full levels.
   * Default false. False/undefined preserves the existing level plan and IR
   * byte-for-byte. A midpoint is omitted when no retained part section exists
   * there, avoiding the full-area extra level this option is meant to prevent.
   */
  intermediateStepdown?: boolean;
  /** Stepover as a FRACTION 0..1 of tool DIAMETER (kept a fraction end-to-end). */
  stepover: number;
  /** Physical milling direction for a clockwise spindle. Defaults to climb. */
  millingDirection?: AdaptiveMillingDirection;
  /** Physical spindle rotation. Production callers must resolve this from tool hand. */
  spindleRotation?: SpindleRotation;
  /** Tangent radius for entering retained-wall cleanup contours, mm. */
  wallLeadInRadius?: number;
  /** Tangent radius for leaving retained-wall cleanup contours, mm. */
  wallLeadOutRadius?: number;
  /** Stay-down loopback fillet radius as a percent of tool radius. */
  loopbackFilletPct?: number;
  /** Follow a shared wall at depth instead of retracting between nearby passes. */
  integralWallFollow?: boolean;
  /** Maximum wall-follow route length divided by straight-line distance. */
  integralWallFollowLengthFactor?: number;
  /** Chordal tolerance, mm. */
  tolerance: number;
  /** Entry helix diameter, mm. */
  helixDiameter: number;
  /** Entry helix descent angle from horizontal, degrees. Defaults to 10. */
  helixAngleDeg?: number;
  /** Radial finish stock left on part walls, mm (applied once, in cutRegionAt). */
  radialStockToLeave?: number;
  /** Axial finish stock left on the floor, mm (raises the computed floor). */
  axialStockToLeave?: number;
  heights: { clearanceZ: number; retractZ: number; feedZ: number };
  /** Highest material this operation can meet, proven by resolved real stock. */
  materialTopZ: number;
  /**
   * WO-096 (fix round). The caller ASSERTS that `stockBounds` is the real,
   * complete stock this operation will meet -- resolved from an actual stock
   * object that contains this part -- and not a box derived from the part's own
   * AABB or from some other stock that happens to be nearby.
   *
   * DEFAULT FALSE, and that default is load-bearing: only the caller knows where
   * the box came from, so absent an assertion the ZDexelField is treated as
   * possibly incomplete and every below-clearance link is routed over the
   * clearance plane. A tall box is NOT evidence -- a mismatched but taller stock
   * would otherwise authorize low links against a field that models the wrong
   * material. Inference here was the second safety hole this WO had to close.
   */
  stockBoundsAreRealStock?: boolean;
  /** Optional floor override; default computed from the part heightfield. */
  floorZ?: number;
  /** Optional clip region for the whole job (geom2d convention). */
  boundary?: readonly Ring[];
  /**
   * Corner-reach (Stage C-2), mm the cut region is dilated OUTWARD past the
   * stock edge (in cutRegionAt) before the engine insets by toolRadius. Set by
   * the caller ONLY in the full-clear branch (field == stock); 0/undefined in
   * part-bounds / fallback mode (dilating there would gouge uncleared stock).
   */
  reachStockEdgeBy?: number;
  /**
   * WO-277: start from the field a PREVIOUS rough left behind instead of a full
   * stock box, so this operation only works the material that one could not
   * reach. Absent -> a full box from stockBounds, byte-identical to before.
   *
   * The field is CLONED before the carve (a run that throws must leave the
   * caller's field exactly as it found it) and is REFUSED unless it provably
   * describes the same situation as this request -- see retainedStockMismatches.
   */
  startFromStock?: ZDexelField;
  /** Store-derived outside-in entry for a proven full-stock clearing region. */
  sideEntry?: boolean;
}

/** The frame grown by enough whole cells on every side to hold `margin` mm plus one cell (0: unchanged). */
function padFrameBeyondStock(frame: GridFrame, margin: number): GridFrame {
  if (!(margin > 0)) return frame;
  const pad = Math.ceil(margin / frame.cell) + 1;
  return {
    originX: frame.originX - pad * frame.cell,
    originY: frame.originY - pad * frame.cell,
    nx: frame.nx + 2 * pad,
    ny: frame.ny + 2 * pad,
    cell: frame.cell,
  };
}

/**
 * WO-2169: take the load-search wobble out of the long straight passes a full-clear
 * rough runs along the stock edge. The planner steers every step to hold its load
 * inside a +-5% band, so a pass nothing bounds wanders a few hundredths of a
 * millimetre side to side (stepped-boss: centre y -0.743, -0.830, -0.776 along one
 * edge). Around the part the region boundary clamped those runs straight and links
 * split them; in full-clear one pass rides each stock edge for its whole length and
 * every wobble is a direction flip (86% of the flips WO-2145 added turn < 5 deg).
 *
 * Within one run of same-Z cut feeds (never a wall-cleanup move), a stretch at least
 * `minChord` long whose points all lie within `band` of the chord joining its ends,
 * on BOTH sides of it, is replaced by that chord. Only a wobble qualifies: a real
 * curve bows to one side, and a curve round a part island is never that straight
 * over a whole cutter diameter; its points stay for the arc fit. Kept moves are the
 * planner's own objects; only the points between are dropped. The search for the
 * far end carries on past a stretch that leaves the band (a wobble comes back) and
 * gives up after STRAIGHTEN_MISSES misses in a row.
 */
const STRAIGHTEN_MISSES = 24;

function straightenPassWobble(
  moves: readonly IrMove[],
  band: number,
  keep: ReadonlySet<IrMove>,
  minChord: number,
): IrMove[] {
  const straightenable = (move: IrMove, prev: IrMove): boolean =>
    move.t === 'feed' && move.role === 'cut' && !keep.has(move)
    && Math.abs(move.z - prev.z) <= 1e-9 && move.f === prev.f;
  const out: IrMove[] = [];
  let i = 0;
  while (i < moves.length) {
    out.push(moves[i]);
    // A run: moves[i] is its start point, moves[i+1..end] straightenable feeds.
    let end = i;
    while (end + 1 < moves.length && straightenable(moves[end + 1], moves[end])) end++;
    let a = i;
    while (a < end) {
      const p = moves[a];
      let best = -1;
      let misses = 0;
      for (let b = a + 2; b <= end && misses < STRAIGHTEN_MISSES; b++) {
        const q = moves[b];
        const len = Math.hypot(q.x - p.x, q.y - p.y);
        if (!(len > 1e-9)) break;
        let above = false;
        let below = false;
        let inside = true;
        for (let k = a + 1; k < b; k++) {
          const dev = ((q.x - p.x) * (moves[k].y - p.y) - (q.y - p.y) * (moves[k].x - p.x)) / len;
          const along = ((q.x - p.x) * (moves[k].x - p.x) + (q.y - p.y) * (moves[k].y - p.y)) / len;
          if (Math.abs(dev) > band || along < -band || along > len + band) { inside = false; break; }
          if (dev > 1e-9) above = true;
          else if (dev < -1e-9) below = true;
        }
        if (!inside) { misses++; continue; }
        misses = 0;
        if (above && below && len >= minChord) best = b;
      }
      const next = best > 0 ? best : a + 1;
      out.push(moves[next]);
      a = next;
    }
    i = end + 1;
  }
  return out;
}

type LapPt = { x: number; y: number };

/** Even-odd membership of a point in engine loops ({x,y}[][]). */
function insideLoops(loops: readonly (readonly LapPt[])[], x: number, y: number): boolean {
  let inside = false;
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[i], b = loop[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

/** True when a cutter disk of `reach` at (x, y) touches no material of `section`. */
function diskInAir(section: readonly Ring[], x: number, y: number, reach: number): boolean {
  let inside = false;
  for (const ring of section) {
    if (pointInRing(ring, x, y)) inside = !inside;
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = ring[2 * j], ay = ring[2 * j + 1];
      const dx = ring[2 * i] - ax, dy = ring[2 * i + 1] - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
      if (Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= reach) return false;
    }
  }
  return !inside;
}

/** Points every `spacing` mm along a -> b, both ends included. */
function chordSamples(a: LapPt, b: LapPt, spacing: number): LapPt[] {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / spacing));
  const out: LapPt[] = [];
  for (let k = 0; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  return out;
}

/** Distance from a point to the nearest edge of engine loops. */
function distanceToLoops(loops: readonly (readonly LapPt[])[], x: number, y: number): number {
  let best = Infinity;
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[j], dx = loop[i].x - a.x, dy = loop[i].y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
    }
  }
  return best;
}

/**
 * WO-2169: a full-clear rough of a part that fills its own box stock ends a level with
 * the wall lap round the part island, and where the part wall IS the stock edge most of
 * that lap runs in air. On the feature-block pocket levels the planner lifts from the
 * pocket corner to the block's outside corner (S), rides up the outside of the block to
 * the pocket mouth, laps the pocket walls, then rides ~160 mm of air round the other
 * three sides back to S: a retract a level the around-part route never made, and air
 * cut at feed.
 *
 * "Air" is judged against the stock at the START of the level, which includes the part:
 * a cutter disk (radius + tolerance) there touches nothing, before or after any pass.
 * The lap's leading air stretch is dropped and the link reaches the lap where it first
 * meets stock at depth - straight, or through one waypoint M midway between the two
 * ends of the lap's air - when every point of that route lies in the planner's own
 * tool-centre region (cutRegion, which already holds the cutter off the part; the
 * emitter still pecks any link the live stock says would plough). The lap still ends
 * at S, where the planner ended it: its trailing air stretch is kept unless a shorter
 * route back to S through the same air exists (M, then the dropped leading stretch
 * backwards), ridden as a keep-down loopback. Anything else is returned unchanged.
 */
function enterWallLapAtDepth(
  passes: readonly AdaptivePass[],
  cutRegion: readonly (readonly LapPt[])[],
  stockSection: readonly Ring[],
  toolRadius: number,
  tolerance: number,
): readonly AdaptivePass[] {
  const li = passes.length - 1;
  if (li < 1) return passes;
  const lap = passes[li];
  const link = passes[li - 1];
  if (lap.type !== 'cut' || link.type !== 'link' || link.jumpType !== 2) return passes;
  const pts = lap.points;
  if (pts.length < 3) return passes;
  const land = link.points[1];
  if (Math.hypot(pts[0].x - land.x, pts[0].y - land.y) > tolerance) return passes;
  const reach = toolRadius + tolerance;
  const spacing = Math.max(tolerance, toolRadius / 4);
  const inAir = (a: LapPt, b: LapPt) =>
    chordSamples(a, b, spacing).every((q) => diskInAir(stockSection, q.x, q.y, reach));
  const inRegion = (a: LapPt, b: LapPt) => chordSamples(a, b, spacing).every((q) =>
    insideLoops(cutRegion, q.x, q.y) || distanceToLoops(cutRegion, q.x, q.y) <= tolerance);
  const length = (route: readonly LapPt[]) =>
    route.reduce((sum, q, k) => (k === 0 ? 0 : sum + Math.hypot(q.x - route[k - 1].x, q.y - route[k - 1].y)), 0);
  const end = pts.length - 1;
  // f: the last point of the lap's leading air stretch; g: the first of its trailing one.
  let f = 0;
  while (f < end && inAir(pts[f], pts[f + 1])) f++;
  if (f === 0 || f === end) return passes;
  let g = end;
  while (g - 1 > f && inAir(pts[g - 1], pts[g])) g--;
  const from = link.points[0];
  const to = pts[f];
  const mid = { x: (pts[f].x + pts[g].x) / 2, y: (pts[f].y + pts[g].y) / 2 };
  let entry: LapPt[];
  if (inRegion(from, to)) entry = [from, to];
  else if (g < end && inRegion(from, mid) && inRegion(mid, to)) entry = [from, mid, to];
  else return passes;
  const out = passes.slice(0, li - 1);
  for (let k = 1; k < entry.length; k++) out.push({ type: 'link', points: [entry[k - 1], entry[k]], jumpType: 1 });
  const closed = Math.hypot(pts[0].x - pts[end].x, pts[0].y - pts[end].y) <= tolerance;
  if (closed && g < end && inAir(pts[g], mid) && inRegion(pts[g], mid)) {
    // Back to S through the same air: M, the nearest leading-air point M reaches, then
    // the leading stretch backwards.
    let k = 0;
    while (k < f && !(inAir(mid, pts[k]) && inRegion(mid, pts[k]))) k++;
    const back = [pts[g], mid, ...pts.slice(0, k + 1).reverse()];
    if ((k < f || (inAir(mid, pts[f]) && inRegion(mid, pts[f]))) && length(back) < length(pts.slice(g))) {
      out.push({ type: 'cut', points: pts.slice(f, g + 1) });
      out.push({ type: 'loopback', points: back.slice(1) });
      return out;
    }
  }
  out.push({ type: 'cut', points: pts.slice(f) });
  return out;
}

function fail(msg: string): never {
  throw new Error(`adaptiveRough: ${msg}`);
}

function boundedWallContactFrame(
  stockFrame: GridFrame,
  requestedCell: number,
  maxCells = 750_000,
): GridFrame {
  const width = stockFrame.nx * stockFrame.cell;
  const height = stockFrame.ny * stockFrame.cell;
  const cell = Math.min(
    stockFrame.cell,
    Math.max(requestedCell, Math.sqrt((width * height) / maxCells)),
  );
  return {
    originX: stockFrame.originX,
    originY: stockFrame.originY,
    nx: Math.max(1, Math.ceil(width / cell - 1e-9)),
    ny: Math.max(1, Math.ceil(height / cell - 1e-9)),
    cell,
  };
}

class RetainedModelCollisionError extends Error {
  constructor(message: string) {
    super(`adaptiveRough: ${message}`);
    this.name = 'RetainedModelCollisionError';
  }
}

/**
 * Final retained-model safety gate. Planning uses an outward-conservative
 * sampled section, but no generated path is publishable until the geometry
 * kernel independently proves that a conservative cutter envelope can occupy
 * every emitted segment without intersecting the selected mesh.
 */
async function assertMovesClearRetainedModel(
  kernel: GeometryKernel,
  mesh: MeshHandle,
  cutter: CutterSpec,
  moves: readonly IrMove[],
  zSeed: number,
  maxRetainedZ: number,
  tolerance: number,
  signal?: AbortSignal,
): Promise<void> {
  if (moves.length === 0) return;
  // Neighboring samples are at most `maxChord` apart in 3D. The union of the
  // cutter discs at those samples covers the true swept capsule except for a
  // sliver along its sides whose depth is the chord's sagitta on the cutter
  // circle, maxChord^2 / (8 R) (a fin between two samples is under both discs,
  // because maxChord << R). Padding the validation cutter by that sagitta is
  // therefore an exact cover of the unsampled path.
  //
  // WO-402c: until 2026-08-19 the pad was maxChord / 2 = min(0.025, tol/2, ..)
  // - for the common tol 0.05 EQUAL to the planner's finish stock (tol/2), so
  // a wall-riding move (a helix entry sitting on the finish-stock line) was a
  // coin flip against the retained model: two equal margins, one numeric
  // touch. The pad now stays strictly below the finish stock for every
  // tolerance (sagitta of a 0.05 chord on a 4.76 mm radius: 0.00007 mm).
  const maxChord = Math.max(
    0.005,
    Math.min(0.05, tolerance, cutter.diameter / 128),
  );
  const sampleGapPad = (maxChord * maxChord) / (8 * (cutter.diameter / 2));
  const validationCutter: CutterSpec = {
    ...cutter,
    diameter: cutter.diameter + 2 * sampleGapPad,
  };
  const cutterHandle = kernel.makeCutter(validationCutter);
  try {
    const chunkCapacity = 32_768;
    let sampleXy: number[] = [];
    let sampleZ: number[] = [];
    let sourceMove: number[] = [];
    const numericalSlack = 1e-4;

    // Endpoint preflight is intentionally separate from the denser continuous
    // sweep. It catches the common sampled-boundary failure quickly enough to
    // trigger a conservative replan without first walking the entire path.
    const endpointXy = Float64Array.from(moves.flatMap((move) => [move.x, move.y]));
    const physicalCutterHandle = kernel.makeCutter(cutter);
    let endpointSafeZ: Float64Array;
    try {
      endpointSafeZ = await kernel.dropPoints(
        mesh,
        physicalCutterHandle,
        endpointXy,
        zSeed,
        signal !== undefined ? { signal } : undefined,
      );
    } finally {
      kernel.releaseCutter(physicalCutterHandle);
    }
    for (let moveIndex = 0; moveIndex < moves.length; moveIndex++) {
      const move = moves[moveIndex];
      if (move.z + numericalSlack >= maxRetainedZ) continue;
      if (move.z + numericalSlack < endpointSafeZ[moveIndex]) {
        throw new RetainedModelCollisionError(
          `retained-model collision on move ${moveIndex}: commanded tool tip `
          + `(${move.x.toFixed(4)}, ${move.y.toFixed(4)}, ${move.z.toFixed(4)}) `
          + `requires Z >= ${endpointSafeZ[moveIndex].toFixed(4)} for the conservative cutter envelope`,
        );
      }
    }

    const flush = async (): Promise<void> => {
      if (sampleZ.length === 0) return;
      const safeTipZ = await kernel.dropPoints(
        mesh,
        cutterHandle,
        Float64Array.from(sampleXy),
        zSeed,
        signal !== undefined ? { signal } : undefined,
      );
      for (let index = 0; index < sampleZ.length; index++) {
        if (sampleZ[index] + numericalSlack < safeTipZ[index]) {
          const x = sampleXy[index * 2];
          const y = sampleXy[index * 2 + 1];
          throw new RetainedModelCollisionError(
            `retained-model collision refused on move ${sourceMove[index]}: commanded tool tip `
            + `(${x.toFixed(4)}, ${y.toFixed(4)}, ${sampleZ[index].toFixed(4)}) `
            + `requires Z >= ${safeTipZ[index].toFixed(4)} for the conservative cutter envelope`,
          );
        }
      }
      sampleXy = [];
      sampleZ = [];
      sourceMove = [];
    };

    const pushSample = (x: number, y: number, z: number, moveIndex: number): void => {
      // A cutter whose tip is at or above the mesh's highest point cannot
      // intersect it. Avoid sending long clearance and approach motion to the
      // geometry kernel; this is an exact bound, not a relaxed collision test.
      if (z + numericalSlack >= maxRetainedZ) return;
      sampleXy.push(x, y);
      sampleZ.push(z);
      sourceMove.push(moveIndex);
    };

    pushSample(moves[0].x, moves[0].y, moves[0].z, 0);
    for (let moveIndex = 1; moveIndex < moves.length; moveIndex++) {
      throwIfAborted(signal);
      const start = moves[moveIndex - 1];
      const end = moves[moveIndex];
      let planarLength = Math.hypot(end.x - start.x, end.y - start.y);
      let startAngle = 0;
      let sweep = 0;
      let centerX = 0;
      let centerY = 0;
      let radius = 0;
      const isArc = end.t === 'arc' && end.i !== undefined && end.j !== undefined;
      if (isArc) {
        centerX = start.x + end.i!;
        centerY = start.y + end.j!;
        radius = Math.hypot(start.x - centerX, start.y - centerY);
        startAngle = Math.atan2(start.y - centerY, start.x - centerX);
        const endAngle = Math.atan2(end.y - centerY, end.x - centerX);
        sweep = endAngle - startAngle;
        if (end.cw) {
          while (sweep >= 0) sweep -= Math.PI * 2;
        } else {
          while (sweep <= 0) sweep += Math.PI * 2;
        }
        planarLength = Math.abs(sweep) * radius;
      }
      const dz = end.z - start.z;
      const steps = Math.max(1, Math.ceil(Math.hypot(planarLength, dz) / maxChord));
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const x = isArc ? centerX + radius * Math.cos(startAngle + sweep * t) : start.x + (end.x - start.x) * t;
        const y = isArc ? centerY + radius * Math.sin(startAngle + sweep * t) : start.y + (end.y - start.y) * t;
        pushSample(x, y, start.z + dz * t, moveIndex);
        if (sampleZ.length >= chunkCapacity) await flush();
      }
    }
    await flush();
  } finally {
    kernel.releaseCutter(cutterHandle);
  }
}

function abortError(): Error {
  const err = new Error('adaptiveRough: operation aborted');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) throw abortError();
}

function cutterIdOf(spec: CutterSpec): string {
  switch (spec.kind) {
    case 'flat':
    case 'ball':
      return `${spec.kind}-d${spec.diameter}`;
    case 'bull':
      return `bull-d${spec.diameter}-cr${spec.cornerRadius}`;
    case 'vbit':
      return `vbit-d${spec.diameter}-a${spec.angleFromAxisDeg}`;
  }
}

/**
 * Refuse caller stock proof when the sampled part extends outside the field.
 * This is a coverage decision, so a distance tolerance cannot establish it.
 */
export function fieldContradictsStockTop(part: ZDexelField, stockTopZ: number): boolean {
  if (part.coverageMaxTopZ !== undefined) {
    return Number.isFinite(part.coverageMaxTopZ) && stockTopZ < part.coverageMaxTopZ;
  }
  let partTopMax = Number.NEGATIVE_INFINITY;
  for (let c = 0; c < part.top.length; c++) {
    if (part.top[c] > part.bottom[c] && part.top[c] > partTopMax) partTopMax = part.top[c];
  }
  return Number.isFinite(partTopMax) && stockTopZ < partTopMax;
}

/**
 * WO-277 safety line. A retained carved field may be used as the starting stock
 * ONLY when it provably describes the SAME situation as the request being
 * planned. Starting from a carved field means BELIEVING material is already
 * gone; if that belief is wrong the rougher plans a cut through solid metal at
 * cutting feed. So a mismatch REFUSES: no resampling, no re-gridding, no
 * best-effort near-match, and above all no quiet fallback to a full box -- a
 * quiet fallback is how a caller never learns its sequencing is wrong.
 *
 * What is provable HERE is the grid the field stands on and its floor. Its Z TOP
 * is not: a carved field's tops are legitimately lower than the box it came from,
 * so "same stock top" can only be proven from the REQUEST that built it, which is
 * the worker's own record (dispatcher.retainCarvedStock) and is checked there.
 * The two checks are independent on purpose -- a direct caller of this strategy
 * still cannot slip a foreign grid past this one.
 *
 * Returns one human-readable phrase per difference, or [] when the field matches.
 */
export function retainedStockMismatches(
  field: ZDexelField,
  stockBounds: Box3,
  cellSize: number,
): string[] {
  const diffs: string[] = [];
  if (field.requestedCellSize !== cellSize) {
    diffs.push(
      `requested cell size ${cellSize} mm, field was built with ${field.requestedCellSize} mm`,
    );
  }
  if (field.originX !== stockBounds.minX || field.originY !== stockBounds.minY) {
    diffs.push(
      `stock min corner (${stockBounds.minX}, ${stockBounds.minY}) mm, ` +
        `field origin (${field.originX}, ${field.originY}) mm`,
    );
  }
  // ZDexelField.fromBox's own grid formula, evaluated with the field's EFFECTIVE
  // (post-coarsening) cell: together with the requested-cell-size check above it
  // proves the field stands on exactly the grid this request would have built.
  const expectedNx = Math.max(1, Math.ceil((stockBounds.maxX - stockBounds.minX) / field.cell - 1e-9));
  const expectedNy = Math.max(1, Math.ceil((stockBounds.maxY - stockBounds.minY) / field.cell - 1e-9));
  if (field.nx !== expectedNx || field.ny !== expectedNy) {
    diffs.push(
      `stock xy extent needs a ${expectedNx} x ${expectedNy} grid at ${field.cell} mm cells, ` +
        `field is ${field.nx} x ${field.ny}`,
    );
  }
  // The floor is uniform in a box field and removeSweep only ever lowers tops,
  // so one column proves the whole field's bottom plane.
  if (field.bottom.length > 0 && field.bottom[0] !== Math.fround(stockBounds.minZ)) {
    diffs.push(`stock bottom ${stockBounds.minZ} mm, field bottom ${field.bottom[0]} mm`);
  }
  return diffs;
}

/** Validate a retained field against this request, then hand back a private copy. */
function startingStockFromRetained(
  field: ZDexelField,
  stockBounds: Box3,
  cellSize: number,
): ZDexelField {
  const diffs = retainedStockMismatches(field, stockBounds, cellSize);
  if (diffs.length > 0) {
    fail(
      `refusing to start from the retained stock field -- it describes a ` +
        `different situation (${diffs.join('; ')}). A field that does not match ` +
        `this request would report material as already removed and the cut ` +
        `would run through solid stock at feed.`,
    );
  }
  // CLONE: the carve below mutates the field it is given, and an aborted or
  // refused run must leave the caller's retained field exactly as it found it.
  return field.clone();
}

function componentBounds(boundary: Ring): AdaptiveRoughRegionBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < boundary.length; i += 2) {
    const x = boundary[i];
    const y = boundary[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function incrementReason(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function formatReasonCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(', ');
}

// A side-entry operation is allowed to proceed without an interior helix/plunge seed,
// but it is never allowed to turn that freedom into a sustained full-width slot. The
// emitted-path replay below is the authority; a failed interior-entry search is not.
//
// EXPORTED (WO-1217): this number is the strategy's PROMISE about sustained radial
// engagement, and anything that measures or reports engagement against "the cap" must
// read it from here rather than restate it. A second literal elsewhere would keep
// scoring against the old bound the day this one moves, and a report that classified an
// engagement regression as green would be worse than no report.
// NAME IS HISTORICAL: since WO-1252 this cap governs BOTH entry modes - an
// interior-entry path is measured and refused against exactly this number. The
// rename is a separate clerical sweep because the symbol is exported and read by
// src/tests/benchmark/registry.ts and two benchmark tests.
export const SIDE_ENTRY_ENGAGEMENT_CAP = 0.75;
// Likewise historical: since WO-1252 this transient allowance separates a report
// from a refusal in BOTH entry modes. It bounds a DIFFERENT quantity in each -
// the whole-path over-cap sum for side entry (main's landed condition, untouched),
// one unbroken over-cap stretch for interior entry - and the refusal rows below
// say why.
const SIDE_ENTRY_MAX_TRANSIENT_OVER_CAP_MM = 2;

/**
 * Refuse a clean completion when most genuinely machinable regions produced no
 * path. Candidates erased by the cutter-radius offset are excluded before they
 * reach this accounting; a remaining skip is therefore an engine refusal, not
 * normal filtering of a sub-tool-width remnant.
 */
export function adaptiveRoughCompletionError(
  diagnostics: AdaptiveRoughDiagnostics,
  opts?: {
    /** WO-277: this run started from a previous rough's retained field. */
    startedFromRetainedStock?: boolean;
  },
): string | undefined {
  // WO-277. Both verdicts below read "the tool could not work what was there" as
  // evidence the OPERATION is wrong. That inference holds for a rough starting
  // from a full block: material the tool cannot fit means the job was set up with
  // the wrong tool. It is exactly backwards for a rest pass: a rough that starts
  // from the field a previous one left is asked to cut only the remainder, and
  // remainder the tool cannot fit is the expected, correct residue -- it is what
  // the NEXT, smaller tool is for. Taken literally the guard would make "the
  // previous rough left nothing this tool can reach" an error, which is the one
  // outcome this order must be able to report. The regions are still counted and
  // still travel to the caller in diagnostics.issues; only the refusal is lifted.
  if (opts?.startedFromRetainedStock === true) return undefined;
  const cutterErasedRegions = diagnostics.cutterErasedRegions ?? 0;
  if (diagnostics.plannedRegions === 0 && cutterErasedRegions > 0) {
    return (
      `${cutterErasedRegions} adaptive region${cutterErasedRegions === 1 ? '' : 's'} ` +
      'could not fit the selected tool; refusing a clean completion'
    );
  }
  if (
    diagnostics.plannedRegions === 0 ||
    diagnostics.skippedRegions <= diagnostics.machinedRegions
  ) {
    return undefined;
  }
  const reasons = formatReasonCounts(diagnostics.reasonCounts);
  return (
    `${diagnostics.skippedRegions} of ${diagnostics.plannedRegions} machinable adaptive ` +
    `regions produced no toolpath${reasons ? ` (${reasons})` : ''}; ` +
    'refusing a clean completion'
  );
}

/**
 * Per-Z-level 3D adaptive rougher. Returns one deterministic ToolpathIR program;
 * throws (AbortError) rather than returning a partial IR if cancelled (ADR-0003).
 */
interface AdaptiveRoughOpts {
  signal?: AbortSignal;
  onProgress?: Cam3dProgressCallback;
  /**
   * Hand the carved stock field to the caller once, after the carve loop.
   * Auxiliary to the IR; this callback never affects the returned path.
   */
  onCarvedStock?: (stock: ZDexelField) => void;
  /** Structured skipped/partial-region diagnostics for the operation UI. */
  onDiagnostics?: (diagnostics: OperationDiagnostics) => void;
  /** WO-1540: plain-language notices for the app console (what was left out or exceeded). */
  onNotice?: (message: string) => void;
  /**
   * WO-2096: plan independent Z levels in parallel. Only exact matches of the
   * requests the level loop builds are taken from it, so the path is the same
   * with or without a pool.
   */
  plannerPool?: AdaptivePlannerPool;
}

interface InternalAdaptiveRoughOpts extends AdaptiveRoughOpts {
  retainedSafetyProbeDiameter?: number;
  progressRuntime?: AdaptiveProgressRuntime;
  progressAttempt?: number;
  /** Test-only byte-identity oracle. Production always enables the exact cache. */
  disableExactPlanCache?: boolean;
}

interface AdaptiveProgressRuntime {
  readonly startedAt: number;
  phase: string;
  phaseStartedAt: number;
  lastFraction: number;
  readonly phaseTimes: Map<string, number>;
}

function longestProgressPhase(runtime: AdaptiveProgressRuntime): Cam3dProgressTiming | undefined {
  let longest: Cam3dProgressTiming | undefined;
  for (const [phase, elapsedMs] of runtime.phaseTimes) {
    if (!longest || elapsedMs > longest.elapsedMs) longest = { phase, elapsedMs };
  }
  return longest;
}

export async function adaptiveRough(
  kernel: GeometryKernel,
  input: AdaptiveRoughInput,
  opts?: AdaptiveRoughOpts,
): Promise<ToolpathIR> {
  const internalOpts = opts as InternalAdaptiveRoughOpts | undefined;
  const signal = opts?.signal;
  throwIfAborted(signal); // pre-aborted: reject before any work (ADR-0003)

  // One tracker survives safety refinement retries. Percent is monotonic across
  // the whole request; retry 1 owns the reserved 94-99% band instead of
  // restarting at zero. Named phases and measured timings travel separately so
  // the UI can say what is running and which completed phase cost the most.
  const progressAttempt = internalOpts?.progressAttempt ?? 0;
  const progressRuntime = internalOpts?.progressRuntime ?? {
    startedAt: performance.now(),
    phase: '',
    phaseStartedAt: performance.now(),
    lastFraction: 0,
    phaseTimes: new Map<string, number>(),
  };
  const reportProgress = (
    localFraction: number,
    phase: string,
    phaseFraction: number,
    step?: string,
  ): void => {
    if (!opts?.onProgress) return;
    const now = performance.now();
    let completedPhase: Cam3dProgressTiming | undefined;
    if (progressRuntime.phase !== phase) {
      if (progressRuntime.phase) {
        const elapsedMs = now - progressRuntime.phaseStartedAt;
        progressRuntime.phaseTimes.set(
          progressRuntime.phase,
          (progressRuntime.phaseTimes.get(progressRuntime.phase) ?? 0) + elapsedMs,
        );
        completedPhase = { phase: progressRuntime.phase, elapsedMs };
      }
      progressRuntime.phase = phase;
      progressRuntime.phaseStartedAt = now;
    }
    const boundedLocal = Math.max(0, Math.min(1, localFraction));
    const mapped = progressAttempt === 0
      ? boundedLocal * 0.94
      : progressAttempt === 1
        ? 0.94 + boundedLocal * 0.05
        : 0.99;
    const fraction = Math.max(progressRuntime.lastFraction, Math.min(mapped, 0.99));
    progressRuntime.lastFraction = fraction;
    opts.onProgress(fraction, {
      phase,
      ...(step ? { step } : {}),
      phaseFraction: Math.max(0, Math.min(1, phaseFraction)),
      elapsedMs: now - progressRuntime.startedAt,
      phaseElapsedMs: now - progressRuntime.phaseStartedAt,
      attempt: progressAttempt + 1,
      ...(completedPhase ? { completedPhase } : {}),
      ...(longestProgressPhase(progressRuntime)
        ? { longestPhase: longestProgressPhase(progressRuntime)! }
        : {}),
    });
  };
  reportProgress(0.005, 'Initializing geometry', 0);

  const { cutter, stockBounds, cellSize, maxStepdown, stepover, tolerance, helixDiameter } = input;
  const helixAngleDeg = input.helixAngleDeg ?? 10;
  // --- (a) validate scalars fail-loud ------------------------------------
  if (cutter.kind !== 'flat' && cutter.kind !== 'ball') {
    fail(`cutter must be flat or ball for the z-dexel rougher, got ${cutter.kind}`);
  }
  if (!(cutter.diameter > 0) || !Number.isFinite(cutter.diameter)) {
    fail(`invalid cutter diameter ${cutter.diameter}`);
  }
  if (!(cellSize > 0) || !Number.isFinite(cellSize)) fail(`invalid cellSize ${cellSize}`);
  if (!(maxStepdown > 0) || !Number.isFinite(maxStepdown)) fail(`invalid maxStepdown ${maxStepdown}`);
  if (!(stepover > 0) || !(stepover <= 1)) fail(`stepover must be in (0, 1], got ${stepover}`);
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) fail(`invalid tolerance ${tolerance}`);
  if (!(helixDiameter > 0) || !Number.isFinite(helixDiameter)) fail(`invalid helixDiameter ${helixDiameter}`);
  if (!Number.isFinite(helixAngleDeg) || helixAngleDeg < 0.5 || helixAngleDeg > 30) {
    fail(`helixAngleDeg must be in [0.5, 30], got ${helixAngleDeg}`);
  }
  const radialStockToLeave = input.radialStockToLeave ?? 0;
  const axialStockToLeave = input.axialStockToLeave ?? 0;
  const wallLeadInRadius = input.wallLeadInRadius ?? 0;
  const wallLeadOutRadius = input.wallLeadOutRadius ?? 0;
  const wantsSingleWallPass = wallLeadInRadius === 0 && wallLeadOutRadius === 0;
  const loopbackFilletPct = input.loopbackFilletPct ?? 25;
  const integralWallFollow = input.integralWallFollow ?? true;
  const integralWallFollowLengthFactor = input.integralWallFollowLengthFactor ?? 2;
  if (!(radialStockToLeave >= 0) || !Number.isFinite(radialStockToLeave)) {
    fail(`invalid radialStockToLeave ${radialStockToLeave}`);
  }
  if (!(axialStockToLeave >= 0) || !Number.isFinite(axialStockToLeave)) {
    fail(`invalid axialStockToLeave ${axialStockToLeave}`);
  }
  const { clearanceZ, retractZ, feedZ } = input.heights;
  if (!Number.isFinite(clearanceZ) || !Number.isFinite(retractZ) || !Number.isFinite(feedZ)) {
    fail(`non-finite heights clearanceZ=${clearanceZ} retractZ=${retractZ} feedZ=${feedZ}`);
  }
  if (!(wallLeadInRadius >= 0) || !Number.isFinite(wallLeadInRadius)) {
    fail(`invalid wallLeadInRadius ${wallLeadInRadius}`);
  }
  if (!(wallLeadOutRadius >= 0) || !Number.isFinite(wallLeadOutRadius)) {
    fail(`invalid wallLeadOutRadius ${wallLeadOutRadius}`);
  }
  if (!Number.isFinite(loopbackFilletPct) || loopbackFilletPct < 5 || loopbackFilletPct > 100) {
    fail(`loopbackFilletPct must be in [5, 100], got ${loopbackFilletPct}`);
  }
  if (!Number.isFinite(integralWallFollowLengthFactor) || integralWallFollowLengthFactor <= 0) {
    fail(`invalid integralWallFollowLengthFactor ${integralWallFollowLengthFactor}`);
  }
  if (clearanceZ < retractZ || retractZ < feedZ) {
    fail(`heights must satisfy clearanceZ >= retractZ >= feedZ; got ${clearanceZ}, ${retractZ}, ${feedZ}`);
  }
  if (!Number.isFinite(input.materialTopZ)) fail('materialTopZ is not proven and finite');
  if (!(clearanceZ > input.materialTopZ)) {
    fail(`clearanceZ ${clearanceZ} is not strictly above proven material top ${input.materialTopZ}`);
  }
  // WO-096: a traverse plane LEVEL with the material is not a traverse plane --
  // it is a scrape along the top of the block. Both safe planes must sit strictly
  // above the stock top, and the op layer owes us that standoff.
  if (!(retractZ > stockBounds.maxZ)) {
    fail(
      `retractZ ${retractZ} is not strictly above the stock top ${stockBounds.maxZ}; ` +
        `a traverse at or below the top of material is a collision, not a link.`,
    );
  }

  // Both wasm engines must be ready: geom2d (offset/boolean in cutRegionAt) AND
  // the 2D adaptive engine's own clipper (processFeature). They are SEPARATE.
  await ensureGeom2dReady();
  await ensureEngineClipperReady();
  reportProgress(0.02, 'Initializing geometry', 1);

  // --- (b) stock + frame -------------------------------------------------
  // WO-277: the ONE input this order changes. A rough starts from a full stock
  // box, or -- when the caller hands over the field a previous rough left behind
  // -- from THAT field, so this operation only works the material the last one
  // could not reach. Everything downstream (levels, engagement, links, floor) is
  // untouched: it reads whichever field it is handed.
  const stock =
    input.startFromStock !== undefined
      ? startingStockFromRetained(input.startFromStock, stockBounds, cellSize)
      : ZDexelField.fromBox(stockBounds, cellSize);
  const frame = frameOf(stock);
  // Bulk topology and physical emitted stock are deliberately separate. Wall
  // cleanup must be visible to entry/link decisions and the final simulation,
  // but feeding its sub-cell contour back into coarse bulk decomposition can
  // fragment the next level into artificial slivers.
  const displayStock = stock.clone();
  const initialDisplayStock = displayStock.clone();
  const stockTopZ = stockBounds.maxZ;

  // --- (c) part heightfield aligned to the stock grid --------------------
  reportProgress(0.02, 'Sampling model surface', 0);
  const part = await buildPartHeightField(kernel, input.mesh, frame, {
    zSeed: stockBounds.minZ - 1, // below stock bottom: misses read as empty
    ...(signal !== undefined ? { signal } : {}),
    onProgress: (fraction) => reportProgress(
      0.02 + 0.08 * fraction,
      'Sampling model surface',
      fraction,
    ),
  });
  throwIfAborted(signal);
  // Full-stock cleanup around a prismatic part is the common case where a
  // point/tolerance probe predictably aliases a vertical wall, fails the exact
  // gate after an expensive plan, and then succeeds with the cell-diagonal
  // probe on a second identical plan. Detect that bounded case from the sampled
  // field: only a small number of distinct horizontal top planes means the
  // intervening changes are vertical walls. Curved/sloped fields have many
  // distinct heights and retain the fine tolerance probe to avoid propagating
  // a coarse lateral margin down the surface.
  const planarTopTolerance = Math.max(tolerance, frame.cell * 0.02);
  const planarTops: number[] = [];
  for (let column = 0; column < part.top.length && planarTops.length <= 8; column++) {
    if (!(part.top[column] > part.bottom[column])) continue;
    const top = part.top[column];
    if (!planarTops.some((value) => Math.abs(value - top) <= planarTopTolerance)) {
      planarTops.push(top);
    }
  }
  // The eager cell-diagonal margin is for genuinely coarse prismatic fields.
  // Applying it to normal-resolution pockets visibly changes the cut boundary
  // and can push their accepted corner transient outside the engagement bar.
  const proactivePrismaticSafety = frame.cell >= cutter.diameter / 3
    && planarTops.length <= 8;
  // WO-096: can this stock field PROVE what stands above the tool? Two things
  // must hold, and NEITHER is inferable from the other:
  //
  //  1. the CALLER asserts the box is the real stock containing this part
  //     (input.stockBoundsAreRealStock -- default false; see its doc comment for
  //     why a tall box is not evidence);
  //  2. the assertion must not CONTRADICT the field we just built. If the part
  //     stands above the box top, there is material this field does not contain
  //     and the assertion is provably wrong about its own geometry -- so it is
  //     refused. (Box top EQUAL to the part top is not a contradiction: that is
  //     the block-shaped fixture where the stock IS the part, and the field is
  //     complete. It was the old code's habit of reading a TALL box as evidence
  //     of real stock -- with no assertion behind it -- that had to go.)
  //
  // Fail either and the field cannot clear a low link, so enforceTraverseSafety
  // routes them all over the clearance plane and every descent finishes at feed
  // (named limitation, safe default; see traverseSafety.ts).
  const stockProven =
    input.stockBoundsAreRealStock === true && !fieldContradictsStockTop(part, stockTopZ);

  // --- (d) floor Z -------------------------------------------------------
  let floorZ: number;
  if (input.floorZ !== undefined) {
    if (!Number.isFinite(input.floorZ)) fail(`non-finite floorZ ${input.floorZ}`);
    floorZ = input.floorZ;
  } else {
    let minTop = Infinity;
    for (let c = 0; c < part.top.length; c++) {
      // "No part here" (empty column, top <= bottom) contributes the stock
      // bottom: the whole column is stock to remove down to the floor.
      const hasPart = part.top[c] > part.bottom[c];
      const t = hasPart
        ? Math.min(Math.max(part.top[c], stockBounds.minZ), stockTopZ)
        : stockBounds.minZ;
      if (t < minTop) minTop = t;
    }
    floorZ = (Number.isFinite(minTop) ? minTop : stockBounds.minZ) + axialStockToLeave;
  }
  if (floorZ >= stockTopZ) {
    fail(`computed floorZ ${floorZ} is not below stockTopZ ${stockTopZ} (nothing to rough)`);
  }

  const toolRadius = cutter.diameter / 2;

  // reachStockEdgeBy is the pre-inset stock expansion. processFeature removes
  // one tool radius from it to produce the cutter-centre envelope, so 2R is
  // required to let a fully-clear cutter start R outside the real stock and
  // feed inward. The exterior seed still comes from the real stock footprint,
  // so this envelope enables entry/repositioning without treating air as stock.
  const rawReachStockEdgeBy = input.reachStockEdgeBy ?? 0;
  if (!(rawReachStockEdgeBy >= 0) || !Number.isFinite(rawReachStockEdgeBy)) {
    fail(`invalid reachStockEdgeBy ${rawReachStockEdgeBy}`);
  }
  // WO-402b: side entry declares everything past the real stock footprint as
  // cleared air (buildSideEntrySeed), so the stock edge is NOT a wall for it and
  // the cutter centre must be allowed to stand on that edge: the envelope is at
  // least one tool radius (the store's explicit-overshoot-0 value). With a
  // smaller envelope the planner clips every outside-in pass that comes within
  // R of the stock edge as if it were a model wall, the corridor left for the
  // cutter centre is a fraction of a millimetre, and an 11 mm ring with a
  // 9.52 mm cutter is taken as a slot (99% engagement, 1221 mm over cap;
  // measured 51% / 0 mm over with the envelope).
  const minReachStockEdgeBy = input.sideEntry ? toolRadius : 0;
  const reachStockEdgeBy = Math.min(Math.max(rawReachStockEdgeBy, minReachStockEdgeBy), toolRadius * 2);

  // --- (e) levels --------------------------------------------------------
  // A horizontal face is only cleared by a pass at its own Z. Pin every face
  // the selected tool can stand on so an even stepdown ladder cannot skip it.
  // GridResolutionError deliberately propagates when the sampled field cannot
  // distinguish such a face from a sample of a curve.
  const criticalDepths = findCriticalDepths(part, {
    stockTopZ,
    floorZ,
    axialStockToLeave,
    minFlatArea: Math.PI * toolRadius * toolRadius,
  });
  const fullLevels = planLevels(stockTopZ, floorZ, maxStepdown, criticalDepths);
  const intermediateIntervals = input.intermediateStepdown === true
    ? terraceIntervals(stockTopZ, fullLevels)
    : [];
  const intermediateLevels = new Map(
    intermediateIntervals.map(interval => [interval.z, interval.upperZ]),
  );
  const intermediateByLowerLevel = new Map(
    intermediateIntervals.map(interval => [interval.lowerLevelIndex, interval]),
  );
  const levels = fullLevels;

  // A negative retained-section ring is the outer wall of a pocket: material
  // lies outside it, so the cutter cannot continuously ride around that wall.
  // Keep the dedicated wall emitter for that topology. Positive retained rings
  // are islands/bosses the cutter can circle, where one adaptive owner removes
  // the duplicate wall lap that fixed the dome and stepped-boss paths.
  const hasPocketOuterWall = levels.some((z) =>
    remainingAbove(part, z).some((ring) => area(ring) < 0));
  const singleWallPass = wantsSingleWallPass && !hasPocketOuterWall;

  // Stock decides what remains; this immutable model field decides where the
  // retained wall is. The model-located dome/boss path uses a finer frame and
  // lets the exact collision gate escalate its initial physical-tolerance
  // probe. A pocket keeps the established cell-diagonal field: its outer wall
  // already has a dedicated cutter-contact pass and making the adaptive region
  // independently finer changes that proven two-owner contract.
  const retainedSafetyProbeDiameter = internalOpts?.retainedSafetyProbeDiameter
    ?? (hasPocketOuterWall || proactivePrismaticSafety
      ? frame.cell * Math.SQRT2
      : Math.max(tolerance * 2, 1e-4));
  // WO-2145: with the reach envelope the cutter centre goes past the stock edge,
  // so the model field must see past it too. Sampled only over the stock, a part
  // that touches the stock edge (a part in its own box stock always does) had its
  // section cut off AT the edge, without the probe's outward margin, and the wall
  // pass there rode exactly one tool radius off the part - a touch the
  // retained-model gate rightly refused. A few cells of margin outside the stock
  // let the section close around the part where it really is.
  const retainedGeometryFrame = padFrameBeyondStock(
    hasPocketOuterWall
      ? frame
      : boundedWallContactFrame(frame, Math.max(tolerance, cutter.diameter / 192)),
    reachStockEdgeBy > 0 ? retainedSafetyProbeDiameter : 0,
  );
  reportProgress(0.10, 'Building retained-model safety field', 0);
  const retainedSafetyPart = await buildPartHeightField(kernel, input.mesh, retainedGeometryFrame, {
    zSeed: stockBounds.minZ - 1,
    probe: {
      kind: 'flat',
      diameter: retainedSafetyProbeDiameter,
    },
    ...(signal !== undefined ? { signal } : {}),
    onProgress: (fraction) => reportProgress(
      0.10 + 0.08 * fraction,
      'Building retained-model safety field',
      fraction,
    ),
  });
  throwIfAborted(signal);

  // Direct cutter-contact field for the immutable wall cleanup. It is not fed
  // to the adaptive planner (so it cannot multiply pass complexity); it only
  // supplies the final cutter-center wall contour at each level.
  const wallContactFrame = boundedWallContactFrame(
    frame,
    Math.max(tolerance, cutter.diameter / 192),
  );
  reportProgress(0.18, 'Building wall-contact field', 0);
  const wallContactPart = singleWallPass ? undefined : await buildPartHeightField(kernel, input.mesh, wallContactFrame, {
    zSeed: stockBounds.minZ - 1,
    probe: {
      ...cutter,
      diameter: cutter.diameter + wallContactFrame.cell * Math.SQRT2 + tolerance,
    },
    ...(signal !== undefined ? { signal } : {}),
    onProgress: (fraction) => reportProgress(
      0.18 + 0.08 * fraction,
      'Building wall-contact field',
      fraction,
    ),
  });
  throwIfAborted(signal);

  reportProgress(0.28, 'Planning adaptive toolpath', 0, `${levels.length} Z levels`);

  // --- (f) roughing pass params for the 2D engine ------------------------
  const arcTol = hasPocketOuterWall
    ? Math.max(tolerance * 0.25, 0.01)
    : Math.max(tolerance * 0.125, 0.0025);
  const selectedMillingDirection = input.millingDirection ?? 'climb';
  // Direct strategy fixtures predate tool handedness and model a standard RH/CW cutter.
  // The production operation and worker boundaries require an explicit resolved value.
  const spindleRotation = input.spindleRotation ?? 'cw';
  const millingDirection = directionForClockwisePlanner(
    selectedMillingDirection,
    spindleRotation,
  );
  const procParams: ProcessParams = {
    toolRadius,
    stepOver: stepover, // FRACTION of diameter, end-to-end (see feature.ts)
    tolerance,
    helixDiameter,
    stockToLeave: 0, // radial skin owned by cutRegionAt -- do NOT double-apply
    arcTol,
    millingDirection,
    loopbackFilletPct,
    // Match the adaptive engine's production default: route between passes through
    // proven-cleared space instead of retracting and re-entering whenever possible.
    integralWallFollow,
    integralWallFollowLengthFactor,
    // Give the final wall band one owner. With no authored wall leads, the
    // adaptive planner clears that band once at the model-located boundary.
    // Explicit wall leads still use the dedicated 3D cleanup emitter.
    wallCleanupAsWeGo: singleWallPass,
    wallFinish: singleWallPass,
    boundedPathCleanup: !hasPocketOuterWall,
    singleWallPass,
    // WO-400: every accepted lift landing also carries a fitting helix, so the
    // emitter can descend safely when the live carved stock disagrees with the
    // planner's polygon model of the landing shaft.
    liftFallbackHelix: true,
  };

  // --- (g) per-level clear + rest ----------------------------------------
  const moves: IrMove[] = [];
  const emitCtx: EmitContext = {
    cursor: { x: NaN, y: NaN, z: clearanceZ },
    helixAngleDeg,
    toolRadius,
    stock: displayStock,
    cutter,
    stockProven,
    millingDirection,
  };
  const heights = { clearanceZ, retractZ, feedZ };
  // Persistent tool-tip position for the removeSweep replay (rest-between-levels).
  let lastTip: ToolTipPosition | null = null;
  // WO-096 traverse-safety accounting, surfaced on ir.meta.params.
  let traverseChecked = 0;
  let traverseRerouted = 0;
  let traverseReroutedHitMaterial = 0;
  let traverseReroutedUnprovable = 0;
  let traverseDescentsChecked = 0;
  let traverseDescentsFedDown = 0;
  // WO-1270: low links the guard raised to material + LOW_TRAVEL_HEADROOM_MM
  // (clear, but by less than the rule), and the smallest air any low lateral
  // traverse actually keeps over the stock model. Both surface on
  // ir.meta.params so the headroom is visible on the path, not only in the
  // source constant.
  let traverseLiftedForHeadroom = 0;
  let minLowTravelGapMm = Number.POSITIVE_INFINITY;
  let wallCleanupContours = 0;
  // WO-1253: wall-contour length left standing because contouring it would have
  // cut over the sustained engagement cap (a slot narrower than the cutter plus
  // its cap, a corner the bulk pass could never bite). Reported, never ploughed.
  let wallRimOverloadMm = 0;
  let wallRimOverloadSpans = 0;
  let terraceEmitted = 0;
  let terraceSkipped = 0;
  let terraceConservativeFallbacks = 0;
  let terraceRemovedVolumeMm3 = 0;
  let terraceChangedAreaMm2 = 0;
  const wallCleanupMoves = new Set<IrMove>();
  let worstTraverse: WorstIntrusion = { worstIntrusionMm: Number.NEGATIVE_INFINITY };
  const roughDiagnostics: AdaptiveRoughDiagnostics = {
    effectiveCellSize: stock.effectiveCellSize,
    toolDiameter: cutter.diameter,
    helixDiameter,
    levelCount: levels.length,
    plannedRegions: 0,
    machinedRegions: 0,
    skippedRegions: 0,
    partialRegions: 0,
    cutterErasedRegions: 0,
    reasonCounts: {},
    issues: [],
  };
  const levelPlanCache = new ExactAdaptiveLevelPlanCache(
    internalOpts?.disableExactPlanCache !== true,
  );

  interface PlannedDepthComponent extends AdaptiveDepthComponentPlan {
    readonly stockSection?: Ring[];
    readonly cleanupRings: Ring[];
  }

  const componentRings = (component: RegionComponent): Ring[] =>
    [component.boundary, ...component.holes];
  const ringDistanceSquared = (ring: Ring, component: RegionComponent): number => {
    let best = Infinity;
    for (const boundary of componentRings(component)) {
      const count = boundary.length / 2;
      for (let i = 0; i < ring.length; i += 2) {
        const px = ring[i];
        const py = ring[i + 1];
        for (let j = 0; j < count; j++) {
          const k = (j + 1) % count;
          const ax = boundary[j * 2];
          const ay = boundary[j * 2 + 1];
          const dx = boundary[k * 2] - ax;
          const dy = boundary[k * 2 + 1] - ay;
          const lengthSquared = dx * dx + dy * dy;
          const t = lengthSquared > 0
            ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
            : 0;
          best = Math.min(best, (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2);
        }
      }
    }
    return best;
  };
  const contactContoursAt = (z: number, verticalOnly: boolean): Ring[] => {
    // The adaptive planner now owns this band at its final offset. A second
    // independent model-contact lap would duplicate that cutting responsibility.
    if (!wallContactPart) return [];
    if (input.boundary !== undefined && input.boundary.length > 0) return [];
    let contours = remainingAbove(wallContactPart, z);
    if (verticalOnly) {
      const aboveContours = remainingAbove(wallContactPart, z + wallContactFrame.cell * 2);
      const contactArea = contours.reduce((sum, ring) => sum + Math.abs(area(ring)), 0);
      const aboveArea = aboveContours.reduce((sum, ring) => sum + Math.abs(area(ring)), 0);
      const verticalProfile = contours.length === aboveContours.length
        && Math.abs(contactArea - aboveArea) <= wallContactFrame.cell * wallContactFrame.cell * 0.1;
      if (!verticalProfile) return [];
    }
    if (contours.length === 0) return [];
    // WO-401: the wall-contact field is the part DILATED by the probe, clipped
    // to its frame. Where the dilated part reaches the frame edge (a part that
    // fills its stock, or stands on the stock edge) the ring runs ALONG that
    // edge - a clip artifact, not a wall the field proved: riding it puts the
    // cutter centre on the stock outline, half the cutter in the part (C3:
    // 'finish' at (0,0,13) on a 90x60 block, refused by the exact gate). Such
    // a ring is dropped whole and named; the bulk passes still clear the level.
    const fx0 = wallContactFrame.originX;
    const fy0 = wallContactFrame.originY;
    const fx1 = fx0 + wallContactFrame.nx * wallContactFrame.cell;
    const fy1 = fy0 + wallContactFrame.ny * wallContactFrame.cell;
    const edgeTol = wallContactFrame.cell * 1.5;
    const touchesFrameEdge = (ring: Ring): boolean => {
      for (let k = 0; k < ring.length; k += 2) {
        const x = ring[k];
        const y = ring[k + 1];
        if (x - fx0 <= edgeTol || fx1 - x <= edgeTol || y - fy0 <= edgeTol || fy1 - y <= edgeTol) return true;
      }
      return false;
    };
    const kept = contours.filter((ring) => !touchesFrameEdge(ring));
    if (kept.length !== contours.length) {
      // eslint-disable-next-line no-console
      console.warn(`[wall-cleanup] ${contours.length - kept.length} contour(s) at z=${z.toFixed(3)} run along the field boundary (part fills the stock there); not a proven wall, skipped (WO-401)`);
    }
    contours = kept;
    if (contours.length === 0) return [];
    if (radialStockToLeave > 0) {
      contours = offset(contours, radialStockToLeave, { joinType: 'round' });
    }
    return contours;
  };
  const wallContoursAt = (z: number): Ring[] => contactContoursAt(z, true);
  const terraceContoursAt = async (z: number): Promise<Ring[]> => {
    if (input.boundary !== undefined && input.boundary.length > 0) return [];
    const exactPartSection = !hasPocketOuterWall && partSectionNeedsModelLocation(retainedSafetyPart, z)
      ? await modelPartSection(kernel, input.mesh, retainedSafetyPart,
        { kind: 'flat', diameter: retainedSafetyProbeDiameter }, z, tolerance * 0.05, signal)
      : remainingAbove(retainedSafetyPart, z);
    if (exactPartSection.length === 0) return [];
    return offset(exactPartSection, toolRadius + radialStockToLeave, { joinType: 'round' });
  };

  // Discover the same stock-aware regions as the historical top-down planner on
  // a private replay field. Actual emission uses the untouched real field below
  // and may then follow independent geometry branches through depth.
  const planningStock = stock.clone();
  const planningEmitCtx: EmitContext = {
    ...emitCtx,
    cursor: { ...emitCtx.cursor },
    stock: planningStock,
  };
  let planningTip: ToolTipPosition | null = null;
  const plannedComponents: PlannedDepthComponent[] = [];
  const plannedTerraces: AdaptiveTerraceCandidate[] = [];

  // The model-located part section at a level reads only the immutable model
  // and retained-safety field, so it is computed once per level even when the
  // speculative pass below asks for it first (WO-2096).
  const levelPartSections = new Map<number, Promise<Ring[] | undefined>>();
  const levelPartSection = (li: number): Promise<Ring[] | undefined> => {
    let section = levelPartSections.get(li);
    if (section === undefined) {
      const z = levels[li];
      section = !hasPocketOuterWall && partSectionNeedsModelLocation(retainedSafetyPart, z)
        ? modelPartSection(kernel, input.mesh, retainedSafetyPart,
          { kind: 'flat', diameter: retainedSafetyProbeDiameter }, z, tolerance * 0.05, signal)
        : Promise.resolve(undefined);
      levelPartSections.set(li, section);
    }
    return section;
  };

  // The planner requests of one level, read from `field`. Undefined when the
  // level has nothing to cut.
  const levelRequestsFrom = async (field: ZDexelField, li: number): Promise<{
    comps: RegionComponent[];
    plannerRequests: AdaptiveLevelPlanRequest[];
    stockSecForEmit: Ring[] | undefined;
  } | undefined> => {
    const z = levels[li];
    const exactPartSection = await levelPartSection(li);
    let region = await cutRegionAt(field, retainedSafetyPart, z, {
      radialStockToLeave,
      reachStockEdgeBy,
      partSection: exactPartSection,
    });
    if (region.length === 0) return undefined;
    if (input.boundary !== undefined && input.boundary.length > 0) {
      region = boolean(region, input.boundary, 'intersect');
      if (region.length === 0) return undefined;
    }

    // OPT-IN outside-in seed: built ONCE per level from the stock section, then
    // shared by every component at this level. Dormant (undefined) unless
    // input.sideEntry is truthy -- then the call below is exactly as today.
    let clearedSeed: ReturnType<typeof buildSideEntrySeed> | undefined;
    // The SAME stock section feeds both the seed build and the side-entry emit
    // (the lead-in descends in air outside this footprint). Lifted so it is
    // computed once. Undefined unless sideEntry is on -> emit call byte-identical.
    let stockSecForEmit: Ring[] | undefined;
    if (input.sideEntry) {
      const stockSec = remainingAbove(field, z);
      if (stockSec.length) {
        stockSecForEmit = stockSec;
        // WO-2145: the part is never air, even where it stands past the stock edge.
        const partSec = exactPartSection ?? remainingAbove(retainedSafetyPart, z);
        clearedSeed = buildSideEntrySeed(stockSec, toolRadius, radialStockToLeave > 0 && partSec.length > 0
          ? offset(partSec, radialStockToLeave, { joinType: 'round' })
          : partSec);
      }
    }

    let comps = decomposeToComponents(region);
    // WO-2145: in full-clear the region reaches past the stock into air. Where the
    // part fills the stock up to its edge (a box part in its own box stock), that
    // leaves components of pure air round the part, with no stock in them at all.
    // There is nothing to cut there; planned, each one found no start point and the
    // rough refused. Only components that hold material are regions.
    if (stockSecForEmit !== undefined) {
      const stockSec = stockSecForEmit;
      comps = comps.filter((comp) => boolean(componentRings(comp), stockSec, 'intersect')
        .reduce((sum, ring) => sum + area(ring), 0) > tolerance * tolerance);
      if (comps.length === 0) return undefined;
    }
    // WO-2168: a component with holes is the stock ring round part islands only
    // where its outer ring really reaches past the stock (by the reach envelope).
    // A pocket with an island in a part-box stock (WO-2145's full-clear route) has
    // the MODEL's pocket wall as its outer ring, wholly inside the stock: that wall
    // keeps its cleanup pass, or ~850 mm3 of wall stock is left for the finisher
    // (benchmark engagement-pocket). The footprint is grown by half the reach so a
    // vertex on the stock edge never decides it; a user boundary keeps the old rule.
    let stockFootprint: Ring[] | undefined;
    const outerRingIsStockEdge = (comp: RegionComponent): boolean => {
      if (input.boundary !== undefined && input.boundary.length > 0) return true;
      if (stockFootprint === undefined) {
        const outers = (stockSecForEmit ?? remainingAbove(field, z)).filter((ring) => area(ring) > 0);
        stockFootprint = outers.length > 0 && reachStockEdgeBy > 0
          ? offset(outers, reachStockEdgeBy / 2, { joinType: 'round' })
          : outers;
      }
      const footprint = stockFootprint;
      for (let i = 0; i + 1 < comp.boundary.length; i += 2) {
        const x = comp.boundary[i], y = comp.boundary[i + 1];
        if (!footprint.some((ring) => area(ring) > 0 && pointInRing(ring, x, y))) return true;
      }
      return false;
    };
    const plannerRequests: AdaptiveLevelPlanRequest[] = comps.map((comp) => ({
      feature: featureFromComponent(comp),
      params: {
        ...procParams,
        // The 3D rougher's emitter descends only through a shaft the LIVE
        // carved stock proves clear (zero tolerance), so a planner allowance
        // for a partly uncut landing can never be honoured here: the planner
        // must route every uncut landing (proven shaft + lead, else helix,
        // else report the region) -- WO-395 / WO-400. The 2D engine keeps its
        // own default; this is the 3D contract only.
        landingUncutCap: 0,
        ...(clearedSeed ? { clearedSeed } : {}),
        // In full-stock edge-reach mode (which side entry implies, see
        // minReachStockEdgeBy), a component with holes is the open exterior
        // stock ring around retained part islands. Its positive-area boundary
        // is a stock edge, not a model wall; cleaning that artificial outer
        // wall creates corner landings where no interior helix can fit, and
        // rode the stock edge at full width to take whatever the passes left
        // (WO-402b, ring 11: 90.8 mm at 99%). Keep every CW island cleanup
        // contour (the real part walls) intact. WO-2168: only when that outer
        // ring is the stock edge, never a model pocket wall.
        ...((reachStockEdgeBy > 0 || clearedSeed) && comp.holes.length > 0 && outerRingIsStockEdge(comp)
          ? { skipOuterBoundaryCleanup: true }
          : {}),
      },
    }));
    return { comps, plannerRequests, stockSecForEmit };
  };

  // WO-2096: with a planner pool, start every level's plan at once. Each
  // level's requests are read here from the replay field before any level is
  // carved into it; the loop below still derives its own requests from the
  // carved field and takes a pooled plan only for a request whose exact key
  // matches, so a level whose region the carving changed is planned in-line as
  // before. Carving one level leaves every lower level's section as it was, so
  // in practice every level's plan runs in parallel.
  // A host without the observation transport uses the in-line callback route.
  const plannerPool = opts?.onProgress && typeof BroadcastChannel !== 'function'
    ? undefined : opts?.plannerPool;
  const speculativePlans = new Map<string, Promise<FeatureResult>>();
  const plannerCoverage = new Map<string, number>();
  const levelCoverage = new Map<number, number>();
  let activePlanner: { key: string; report: (fraction: number) => void } | undefined;
  let planningLevelIndex = 0;
  let planningLevelKeys: string[] = [];
  let lastParallelReportAt = -Infinity;
  const reportParallelActivity = () => {
    if (activePlanner) {
      activePlanner.report(plannerCoverage.get(activePlanner.key) ?? 0);
      return;
    }
    const now = performance.now();
    if (now - lastParallelReportAt < 1_000) return;
    lastParallelReportAt = now;
    const observed = planningLevelKeys.length === 0 ? 0
      : planningLevelKeys.reduce((sum, key) => sum + (plannerCoverage.get(key) ?? 0), 0) / planningLevelKeys.length;
    const coverage = Math.max(levelCoverage.get(planningLevelIndex) ?? 0, observed);
    levelCoverage.set(planningLevelIndex, coverage);
    const fraction = (planningLevelIndex + coverage) / levels.length;
    reportProgress(0.28 + 0.50 * fraction, 'Planning adaptive toolpath', fraction,
      `Z level ${planningLevelIndex + 1}/${levels.length} - ${Math.round(coverage * 100)}% cleared; parallel planners working`);
  };
  const speculation = plannerPool !== undefined && levels.length > 1
    ? new AbortController()
    : undefined;
  try {
  if (plannerPool !== undefined && speculation !== undefined) {
    reportParallelActivity(); // the actual launch, before the first pass observation
    // A cancelled operation stops its pooled plans with it.
    signal?.addEventListener('abort', () => speculation.abort(), { once: true });
    for (let li = 0; li < levels.length; li++) {
      throwIfAborted(signal);
      const level = await levelRequestsFrom(planningStock, li);
      for (const request of level?.plannerRequests ?? []) {
        const key = exactAdaptiveRequestKey(request);
        if (li === 0) planningLevelKeys.push(key);
        if (speculativePlans.has(key)) continue;
        const plan = opts?.onProgress
          ? planWithProgress(plannerPool, request, speculation.signal, fraction => {
              plannerCoverage.set(key, Math.max(plannerCoverage.get(key) ?? 0, fraction));
              reportParallelActivity();
            })
          : plannerPool.plan(request, speculation.signal);
        plan.catch(() => undefined); // an unused plan's cancel is not an error
        speculativePlans.set(key, plan);
      }
    }
  }
  const planRequest = async (
    { feature, params }: AdaptiveLevelPlanRequest,
    requestKey: string,
  ): Promise<FeatureResult> => {
    const pooled = speculativePlans.get(requestKey);
    if (pooled !== undefined) {
      try {
        return await pooled;
      } catch (error) {
        throwIfAborted(signal);
        // eslint-disable-next-line no-console
        console.warn(`[adaptive-planner-pool] planning in-line instead: ${String(error)}`);
      }
    }
    return processFeature(feature, params, fraction => activePlanner?.report(fraction));
  };

  for (let li = 0; li < levels.length; li++) {
    throwIfAborted(signal);
    planningLevelIndex = li;
    if (li > 0) planningLevelKeys = [];
    const z = levels[li];

    const level = await levelRequestsFrom(planningStock, li);
    if (level === undefined) {
      const levelFraction = (li + 1) / levels.length;
      reportProgress(0.28 + 0.50 * levelFraction, 'Planning adaptive toolpath', levelFraction,
        `Z level ${li + 1}/${levels.length}`);
      continue;
    }
    const { comps, plannerRequests, stockSecForEmit } = level;
    const plannedLevel = await levelPlanCache.getOrPlanEach(plannerRequests, async (request, key) => {
      const componentIndex = plannerRequests.indexOf(request);
      let coverage = 0;
      let lastReportedAt = -Infinity;
      const report = (fraction: number) => {
        coverage = Math.max(coverage, fraction);
        const now = performance.now();
        if (now - lastReportedAt < 1_000) return;
        lastReportedAt = now;
        const withinLevel = Math.max(levelCoverage.get(li) ?? 0,
          (componentIndex + coverage) / plannerRequests.length);
        levelCoverage.set(li, withinLevel);
        const phaseFraction = (li + withinLevel) / levels.length;
        reportProgress(0.28 + 0.50 * phaseFraction, 'Planning adaptive toolpath', phaseFraction,
          `Z level ${li + 1}/${levels.length} - component ${componentIndex + 1}/${plannerRequests.length}, ${Math.round(coverage * 100)}% cleared`);
      };
      activePlanner = { key, report };
      report(plannerCoverage.get(key) ?? 0);
      try {
        const result = await planRequest(request, key);
        plannerCoverage.set(key, 1);
        return result;
      } finally {
        activePlanner = undefined;
      }
    });
    const componentPlans: PlannedDepthComponent[] = [];
    for (let ci = 0; ci < comps.length; ci++) {
      const comp = comps[ci];
      const res = plannedLevel.results[ci];
      const passCount = res.passes.length;
      const abortedReason = res.stats.aborted?.trim();

      // processFeature applies the cutter-radius offset that decides whether a
      // polygon component is physically machinable. If that offset erases the
      // component, it was a sub-tool-width candidate, not a planned region that
      // the strategy skipped. Counting these corner/sliver remnants produced
      // WO-097's misleading 3/47 and 8/48 summaries.
      if (abortedReason === 'no-cut-region') {
        roughDiagnostics.cutterErasedRegions =
          (roughDiagnostics.cutterErasedRegions ?? 0) + 1;
        continue;
      }

      roughDiagnostics.plannedRegions++;
      if (passCount > 0) {
        roughDiagnostics.machinedRegions++;
        componentPlans.push({
          originalIndex: ci,
          passes: reachStockEdgeBy > 0 && stockSecForEmit !== undefined
            ? enterWallLapAtDepth(res.passes, res.cutRegion, stockSecForEmit, toolRadius, tolerance)
            : res.passes,
          levelIndex: li,
          z,
          component: comp,
          stockSection: stockSecForEmit,
          cleanupRings: [],
        });
        if (abortedReason) {
          roughDiagnostics.partialRegions++;
          incrementReason(roughDiagnostics.reasonCounts, abortedReason);
          roughDiagnostics.issues.push({
            kind: 'partial',
            z,
            levelIndex: li,
            componentIndex: ci,
            bounds: componentBounds(comp.boundary),
            reason: abortedReason,
            passCount,
          });
        }
      } else {
        const reason = abortedReason || 'zero-passes';
        roughDiagnostics.skippedRegions++;
        incrementReason(roughDiagnostics.reasonCounts, reason);
        roughDiagnostics.issues.push({
          kind: 'skipped',
          z,
          levelIndex: li,
          componentIndex: ci,
          bounds: componentBounds(comp.boundary),
          reason,
          passCount,
        });
      }
    }
    if (componentPlans.length === 0) {
      const levelFraction = (li + 1) / levels.length;
      reportProgress(0.28 + 0.50 * levelFraction, 'Planning adaptive toolpath', levelFraction,
        `Z level ${li + 1}/${levels.length}${plannedLevel.reused ? ' - reused XY plan' : ''}`);
      continue;
    }

    const orderedPlanning = orderAdaptiveComponents(componentPlans, planningEmitCtx.cursor);
    const planningPasses: AdaptivePass[] = [];
    for (const plan of orderedPlanning) planningPasses.push(...plan.passes);
    const planningMoves = emitLevelPasses(
      planningPasses,
      z,
      heights,
      planningEmitCtx,
      stockSecForEmit,
    );
    const planningSafe = enforceTraverseSafety(planningMoves, {
      stock: planningStock,
      cutter,
      clearanceZ,
      materialTopZ: input.materialTopZ,
      stockProven,
      initialTip: planningTip,
    });
    planningTip = planningSafe.lastTip;

    // Discover the material exposed by this exact lower full plane. These are
    // dependency footprints only: actual eligibility re-reads displayStock
    // after every preceding bulk/cleanup move, so rest stock remains truth.
    const terraceInterval = intermediateByLowerLevel.get(li);
    if (terraceInterval !== undefined) {
      const terracePartSection = !hasPocketOuterWall
        && partSectionNeedsModelLocation(retainedSafetyPart, terraceInterval.z)
        ? await modelPartSection(
            kernel,
            input.mesh,
            retainedSafetyPart,
            { kind: 'flat', diameter: retainedSafetyProbeDiameter },
            terraceInterval.z,
            tolerance * 0.05,
            signal,
          )
        : undefined;
      let terraceRegion = await cutRegionAt(planningStock, retainedSafetyPart, terraceInterval.z, {
        radialStockToLeave,
        reachStockEdgeBy,
        ...(terracePartSection !== undefined ? { partSection: terracePartSection } : {}),
      });
      if (input.boundary !== undefined && input.boundary.length > 0) {
        terraceRegion = boolean(terraceRegion, input.boundary, 'intersect');
      }
      for (const component of decomposeToComponents(terraceRegion)) {
        plannedTerraces.push({
          id: plannedTerraces.length,
          z: terraceInterval.z,
          upperZ: terraceInterval.upperZ,
          lowerLevelIndex: li,
          component,
        });
      }
    }

    for (const contour of wallContoursAt(z)) {
      let owner = 0;
      let bestDistance = Infinity;
      for (let pi = 0; pi < componentPlans.length; pi++) {
        const distance = ringDistanceSquared(contour, componentPlans[pi].component);
        if (distance < bestDistance) {
          owner = pi;
          bestDistance = distance;
        }
      }
      componentPlans[owner].cleanupRings.push(contour);
    }
    plannedComponents.push(...componentPlans);

    const levelFraction = (li + 1) / levels.length;
    reportProgress(0.28 + 0.50 * levelFraction, 'Planning adaptive toolpath', levelFraction,
      `Z level ${li + 1}/${levels.length}${plannedLevel.reused ? ' - reused XY plan' : ''}`);
  }

  // Speculative plans the loop did not take stop here, not with the operation.
  } finally {
    activePlanner = undefined;
    speculation?.abort();
  }
  const scheduledEvents = input.intermediateStepdown === true
    ? scheduleAdaptiveDepthBranchesWithTerraces(plannedComponents, plannedTerraces, emitCtx.cursor)
    : scheduleAdaptiveDepthBranches(plannedComponents, emitCtx.cursor)
        .map(plan => ({ kind: 'bulk' as const, plan }));
  const scheduledComponents = scheduledEvents
    .filter((event): event is { kind: 'bulk'; plan: PlannedDepthComponent } => event.kind === 'bulk')
    .map(event => event.plan);
  roughDiagnostics.componentSchedule = scheduledComponents.map((plan, order) => ({
    order,
    levelIndex: plan.levelIndex,
    componentIndex: plan.originalIndex,
    z: plan.z,
  }));
  // Option off keeps the historical diagnostics object byte-identical.
  if (input.intermediateStepdown === true) {
    roughDiagnostics.terraceCandidates = plannedTerraces.length;
  }
  const phaseBlocks: Array<{ kind: 'bulk' | 'terrace'; start: number; end: number }> = [];

  for (let si = 0; si < scheduledEvents.length; si++) {
    throwIfAborted(signal);
    const event = scheduledEvents[si];
    if (event.kind === 'terrace') {
      const { candidate } = event;
      if (event.conservativeFallback) terraceConservativeFallbacks++;
      const exactPartSection = !hasPocketOuterWall
        && partSectionNeedsModelLocation(retainedSafetyPart, candidate.z)
        ? await modelPartSection(
            kernel,
            input.mesh,
            retainedSafetyPart,
            { kind: 'flat', diameter: retainedSafetyProbeDiameter },
            candidate.z,
            tolerance * 0.05,
            signal,
          )
        : undefined;
      let liveRegion = await cutRegionAt(displayStock, retainedSafetyPart, candidate.z, {
        radialStockToLeave,
        reachStockEdgeBy,
        ...(exactPartSection !== undefined ? { partSection: exactPartSection } : {}),
      });
      liveRegion = boolean(liveRegion, componentRings(candidate.component), 'intersect');
      if (input.boundary !== undefined && input.boundary.length > 0) {
        liveRegion = boolean(liveRegion, input.boundary, 'intersect');
      }

      let terraceMoves: IrMove[] = [];
      let terraceOverloads: ReturnType<typeof planWallCleanup>['rimOverloads'] = [];
      if (liveRegion.length > 0 && (input.boundary === undefined || input.boundary.length === 0)) {
        const contours = await terraceContoursAt(candidate.z);
        const peers = plannedTerraces.filter(peer => Math.abs(peer.z - candidate.z) <= 1e-8);
        const ownedContours = contours.filter(ring => {
          let owner = peers[0];
          let best = Infinity;
          for (const peer of peers) {
            const distance = ringDistanceSquared(ring, peer.component);
            if (distance < best - 1e-12 || (Math.abs(distance - best) <= 1e-12 && peer.id < owner.id)) {
              owner = peer;
              best = distance;
            }
          }
          return owner.id === candidate.id;
        });
        if (ownedContours.length > 0) {
          const terrace = planWallCleanup(
            ownedContours,
            displayStock,
            cutter,
            candidate.z,
            lastTip,
            frame.cell * Math.SQRT2 + tolerance,
            millingDirection,
            wallLeadInRadius,
            wallLeadOutRadius,
            Math.max(0.005, Math.min(0.05, tolerance)),
            {
              stockBounds: { ...stockBounds, maxZ: candidate.upperZ },
              cellSize,
              capFraction: SIDE_ENTRY_ENGAGEMENT_CAP,
            },
          );
          terraceMoves = terrace.moves;
          terraceOverloads = terrace.rimOverloads;
        }
      }

      // A no-section cap, or a boundary-clipped interval that cannot legally be
      // represented as a closed wall ring, is cleared as its local live residual
      // component. The lower full cut has already exposed this material.
      if (terraceMoves.length === 0 && liveRegion.length > 0) {
        const terracePlans = decomposeToComponents(liveRegion).flatMap((component, originalIndex) => {
          const result = processFeature(featureFromComponent(component), {
            ...procParams,
            landingUncutCap: 0,
          }, fraction => {
            reportProgress(progressRuntime.lastFraction, 'Clearing intermediate terrace', fraction,
              `Z ${candidate.z.toFixed(3)} - component ${originalIndex + 1}, ${Math.round(fraction * 100)}% cleared`);
          });
          return result.passes.length > 0
            ? [{ originalIndex, passes: result.passes, component }]
            : [];
        });
        const ordered = orderAdaptiveComponents(terracePlans, emitCtx.cursor);
        const tempCtx: EmitContext = { ...emitCtx, cursor: { ...emitCtx.cursor } };
        terraceMoves = emitLevelPasses(
          ordered.flatMap(plan => plan.passes),
          candidate.z,
          heights,
          tempCtx,
        ).map(move => (
          move.z === candidate.z && (move.role === 'cut' || move.role === 'stepover')
            ? { ...move, role: 'finish' as const }
            : move
        ));
      }

      const removal = measureTerraceRemoval(displayStock, cutter, terraceMoves, lastTip);
      if (!terraceRemovalIsProductive(removal, tolerance, candidate.upperZ - candidate.z)) {
        terraceSkipped++;
        continue;
      }
      const blockStart = moves.length;
      const terraceSafe = enforceTraverseSafety(terraceMoves, {
        stock: displayStock,
        cutter,
        clearanceZ,
        materialTopZ: input.materialTopZ,
        stockProven,
        initialTip: lastTip,
      });
      lastTip = terraceSafe.lastTip;
      if (lastTip) Object.assign(emitCtx.cursor, lastTip);
      traverseChecked += terraceSafe.report.checked;
      traverseRerouted += terraceSafe.report.rerouted;
      traverseReroutedHitMaterial += terraceSafe.report.reroutedHitMaterial;
      traverseReroutedUnprovable += terraceSafe.report.reroutedUnprovable;
      traverseDescentsChecked += terraceSafe.report.descentsChecked;
      traverseDescentsFedDown += terraceSafe.report.descentsFedDown;
      traverseLiftedForHeadroom += terraceSafe.report.liftedForHeadroom;
      minLowTravelGapMm = Math.min(minLowTravelGapMm, terraceSafe.report.minLowTravelGapMm);
      worstTraverse = mergeWorstIntrusion(worstTraverse, terraceSafe.report);
      moves.push(...terraceSafe.moves);
      phaseBlocks.push({ kind: 'terrace', start: blockStart, end: moves.length });
      terraceEmitted++;
      terraceRemovedVolumeMm3 += removal.removedVolumeMm3;
      terraceChangedAreaMm2 += removal.changedAreaMm2;
      for (const overload of terraceOverloads) {
        wallRimOverloadMm += overload.lengthMm;
        wallRimOverloadSpans++;
      }
      continue;
    }

    const plan = event.plan;
    const blockStart = moves.length;
    const componentMoves = emitLevelPasses(
      [...plan.passes],
      plan.z,
      heights,
      emitCtx,
      plan.stockSection,
    );
    const safe = enforceTraverseSafety(componentMoves, {
      // The emitted-stock field is the physical authority here. Unlike the
      // bulk planning field it includes every prior wall cleanup and entry, so
      // a following stepdown can prove that its pocket corridor is already
      // clear instead of being rerouted over Clearance Height.
      stock: displayStock,
      cutter,
      clearanceZ,
      materialTopZ: input.materialTopZ,
      stockProven,
      initialTip: lastTip,
    });
    lastTip = safe.lastTip;
    traverseChecked += safe.report.checked;
    traverseRerouted += safe.report.rerouted;
    traverseReroutedHitMaterial += safe.report.reroutedHitMaterial;
    traverseReroutedUnprovable += safe.report.reroutedUnprovable;
    traverseDescentsChecked += safe.report.descentsChecked;
    traverseDescentsFedDown += safe.report.descentsFedDown;
    traverseLiftedForHeadroom += safe.report.liftedForHeadroom;
    minLowTravelGapMm = Math.min(minLowTravelGapMm, safe.report.minLowTravelGapMm);
    worstTraverse = mergeWorstIntrusion(worstTraverse, safe.report);
    moves.push(...safe.moves);

    if (plan.cleanupRings.length > 0) {
      const cleanup = planWallCleanup(
        plan.cleanupRings,
        displayStock,
        cutter,
        plan.z,
        lastTip,
        frame.cell * Math.SQRT2 + tolerance,
        millingDirection,
        wallLeadInRadius,
        wallLeadOutRadius,
        Math.max(0.005, Math.min(0.05, tolerance)),
        // WO-1253. The cleanup contour is a FINISHING pass over a rim, and it only
        // stays one where a rim is what stands in front of it. Where the bulk pass
        // could not reach -- the engagementPocket's 6 mm neck against a 4 mm cutter
        // -- the contour met virgin material and ran 10.2 mm at 101.7% of a full
        // slot. Hand the planner the same ruler the published-path gate below uses
        // so it drops what it cannot take instead of ploughing it.
        {
          stockBounds,
          cellSize,
          capFraction: SIDE_ENTRY_ENGAGEMENT_CAP,
        },
      );
      const cleanupSafe = enforceTraverseSafety(cleanup.moves, {
        stock: displayStock,
        cutter,
        clearanceZ,
        materialTopZ: input.materialTopZ,
        stockProven,
        initialTip: lastTip,
      });
      lastTip = cleanupSafe.lastTip;
      if (lastTip) Object.assign(emitCtx.cursor, lastTip);
      traverseChecked += cleanupSafe.report.checked;
      traverseRerouted += cleanupSafe.report.rerouted;
      traverseReroutedHitMaterial += cleanupSafe.report.reroutedHitMaterial;
      traverseReroutedUnprovable += cleanupSafe.report.reroutedUnprovable;
      traverseDescentsChecked += cleanupSafe.report.descentsChecked;
      traverseDescentsFedDown += cleanupSafe.report.descentsFedDown;
      traverseLiftedForHeadroom += cleanupSafe.report.liftedForHeadroom;
      minLowTravelGapMm = Math.min(minLowTravelGapMm, cleanupSafe.report.minLowTravelGapMm);
      worstTraverse = mergeWorstIntrusion(worstTraverse, cleanupSafe.report);
      for (const move of cleanupSafe.moves) wallCleanupMoves.add(move);
      moves.push(...cleanupSafe.moves);
      wallCleanupContours += cleanup.contourCount;
      for (const overload of cleanup.rimOverloads) {
        wallRimOverloadMm += overload.lengthMm;
        wallRimOverloadSpans += 1;
        // eslint-disable-next-line no-console
        console.warn(
          `[wall-rim-overload] ${overload.lengthMm.toFixed(2)} mm of wall contour at `
          + `z=${overload.z.toFixed(3)} near (${overload.x.toFixed(2)}, ${overload.y.toFixed(2)}) `
          + `would sustain ${(overload.peakFraction * 100).toFixed(0)}% of a full slot -- left `
          + `standing for a finishing pass with a tool that fits (WO-1253)`,
        );
        opts?.onNotice?.(
          'part of a wall contour was left standing because riding it would overload the tool; ' +
          'finish it with a tool that fits.',
        );
      }
    }
    phaseBlocks.push({ kind: 'bulk', start: blockStart, end: moves.length });

    const scheduleFraction = scheduledEvents.length > 0
      ? (si + 1) / scheduledEvents.length
      : 1;
    reportProgress(
      0.72 + 0.06 * scheduleFraction,
      'Emitting stock-aware component schedule',
      scheduleFraction,
      `Node ${si + 1}/${scheduledEvents.length} at Z ${plan.z.toFixed(3)}`,
    );
  }

  if (input.intermediateStepdown === true) {
    roughDiagnostics.terraceEmitted = terraceEmitted;
    roughDiagnostics.terraceSkipped = terraceSkipped;
    roughDiagnostics.terraceConservativeFallbacks = terraceConservativeFallbacks;
    roughDiagnostics.terraceRemovedVolumeMm3 = terraceRemovedVolumeMm3;
    roughDiagnostics.terraceChangedAreaMm2 = terraceChangedAreaMm2;
  }

  roughDiagnostics.plannerCacheHits = levelPlanCache.hits;
  roughDiagnostics.plannerCacheMisses = levelPlanCache.misses;
  roughDiagnostics.plannerUniquePlans = levelPlanCache.uniquePlans;

  const completionError = adaptiveRoughCompletionError(roughDiagnostics, {
    startedFromRetainedStock: input.startFromStock !== undefined,
  });
  if (completionError !== undefined) fail(completionError);

  // Plan/replay against the dense conservative polyline, then compress once.
  // The exact retained-model gate below validates every resulting arc/chord;
  // a fit that bows toward the part is rejected, never published.
  reportProgress(0.80, 'Smoothing toolpath', 0);
  // WO-2169: a full-clear rough straightens its edge-riding passes first (see
  // straightenPassWobble) within 3/4 of the tolerance, so with the fit's 1/4 the
  // published path stays inside the authored tolerance. The result goes through the
  // same fit and the same retained-model gate; the raw planner path stays the fallback.
  const smoothForPublish = (block: IrMove[]) => {
    if (!(reachStockEdgeBy > 0)) return smoothAdaptiveIr(block, tolerance);
    const fitted = smoothAdaptiveIr(straightenPassWobble(block, tolerance * 0.75, wallCleanupMoves, cutter.diameter), tolerance);
    return { ...fitted, removedPoints: block.length - fitted.moves.length };
  };
  // Smooth each bulk phase independently and keep measured terrace phases raw.
  // No fit may bridge a bulk/terrace boundary or two bulk components separated
  // by a terrace revisit.
  let smoothed = input.intermediateStepdown === true
    ? (() => {
        const phaseMoves: IrMove[] = [];
        let removedPoints = 0;
        let arcCount = 0;
        for (const block of phaseBlocks) {
          const blockMoves = moves.slice(block.start, block.end);
          if (block.kind === 'terrace') {
            phaseMoves.push(...blockMoves);
            continue;
          }
          const bulk = smoothForPublish(blockMoves);
          phaseMoves.push(...bulk.moves);
          removedPoints += bulk.removedPoints;
          arcCount += bulk.arcCount;
        }
        return {
          moves: phaseMoves,
          removedPoints,
          arcCount,
        };
      })()
    : smoothForPublish(moves);
  let publishMoves = smoothed.moves;
  let smoothingSafetyFallback = false;
  let wallCleanupSafetyFallback = false;
  let stockReplayMoves: readonly IrMove[] | undefined;
  const validateMoves = async (candidate: readonly IrMove[]): Promise<void> => {
    await assertMovesClearRetainedModel(
      kernel,
      input.mesh,
      cutter,
      candidate,
      Math.min(stockBounds.minZ, floorZ) - cutter.diameter - 1,
      part.coverageMaxTopZ
        ?? part.top.reduce((highest, z) => Math.max(highest, z), Number.NEGATIVE_INFINITY),
      tolerance,
      signal,
    );
  };

  reportProgress(0.84, 'Validating retained-model clearance', 0);
  try {
    await validateMoves(publishMoves);
  } catch (error) {
    let validationError: unknown = error;
    // A visual smoothing fit is optional; retained-model safety is not. If a
    // fitted arc bows toward an immutable wall or a changing 3D silhouette,
    // keep the original planner path and prove that exact path instead. This
    // prevents a smoothing error from triggering the coarse planning fallback
    // and propagating an oversized boundary through all lower levels.
    if (error instanceof RetainedModelCollisionError && publishMoves !== moves) {
      try {
        await validateMoves(moves);
        publishMoves = moves;
        smoothingSafetyFallback = true;
        validationError = undefined;
      } catch (rawError) {
        validationError = rawError;
      }
    }
    // A sampled wall-contact contour is also optional. Its own motion must
    // clear the immutable model independently; if it does not, remove only
    // that cleanup layer and retain the already-proven bulk path. Never widen
    // the part boundary or allow an inaccurate cleanup to seed lower levels.
    // WO-401: removing the cleanup layer must not leave a DIAGONAL between the
    // last bulk move at depth and whatever followed the layer (C3: (17.9, 21.1,
    // z7) straight to the next region's clearance rapid at (32.8, 23.2, z26),
    // sampled by the gate 0.8 mm into the island top). Where a block was
    // removed, a vertical rapid to the following rapid's height is stitched
    // in; if what follows is not a rapid at or above the tool, the layer
    // cannot be dropped safely and this fallback is skipped.
    const dropWallCleanup = (): IrMove[] | null => {
      const out: IrMove[] = [];
      let gap = false;
      for (const move of moves) {
        if (wallCleanupMoves.has(move)) { gap = true; continue; }
        if (gap && out.length > 0) {
          const prev = out[out.length - 1];
          const sameXy = Math.abs(prev.x - move.x) <= 1e-9 && Math.abs(prev.y - move.y) <= 1e-9;
          if (!sameXy) {
            if (move.t !== 'rapid' || move.z + 1e-9 < prev.z) return null;
            if (move.z > prev.z + 1e-9) out.push({ t: 'rapid', role: 'rapid', x: prev.x, y: prev.y, z: move.z });
          }
        }
        gap = false;
        out.push(move);
      }
      return out;
    };
    const bulkOnlyOrNull = validationError instanceof RetainedModelCollisionError && wallCleanupMoves.size > 0
      ? dropWallCleanup()
      : null;
    if (bulkOnlyOrNull !== null) {
      const bulkOnly = bulkOnlyOrNull;
      const smoothBulk = smoothForPublish(bulkOnly);
      try {
        await validateMoves(smoothBulk.moves);
        smoothed = smoothBulk;
        publishMoves = smoothBulk.moves;
        wallCleanupContours = 0;
        wallCleanupSafetyFallback = true;
        stockReplayMoves = bulkOnly;
        validationError = undefined;
      } catch {
        try {
          await validateMoves(bulkOnly);
          smoothed = { moves: bulkOnly, removedPoints: 0, arcCount: 0 };
          publishMoves = bulkOnly;
          smoothingSafetyFallback = true;
          wallCleanupContours = 0;
          wallCleanupSafetyFallback = true;
          stockReplayMoves = bulkOnly;
          validationError = undefined;
        } catch (bulkError) {
          validationError = bulkError;
        }
      }
    }
    if (validationError instanceof RetainedModelCollisionError) {
      // Preserve the witness that required more model margin, rather than
      // presenting the second plan as if the first boundary had been proved.
      console.warn(`[adaptive-model-refine] ${validationError.message}`);
      const fullProbe = retainedGeometryFrame.cell * Math.SQRT2 + 2 * tolerance;
      const nextProbe = retainedSafetyProbeDiameter < fullProbe - 1e-9
        ? fullProbe
        : undefined;
      if (nextProbe === undefined) throw validationError;
      reportProgress(0.94, 'Refining retained-model safety', 0,
        `retry ${progressAttempt + 2}`);
      const retryOpts: InternalAdaptiveRoughOpts = {
        ...opts,
        retainedSafetyProbeDiameter: nextProbe,
        progressRuntime,
        progressAttempt: progressAttempt + 1,
      };
      return adaptiveRough(kernel, input, retryOpts);
    }
    if (validationError !== undefined) throw validationError;
  }

  // Final retract: leave the tool at the clearance plane, as every 2D op and
  // every 3D finish (pathbuild, waterline) already does. Without it the path
  // ends at its last cut and the post stops the spindle (tool change, program
  // end) with the tool still at depth. The lift runs straight up the tool's own
  // axis, through the column the cutter already occupies, so it removes no
  // stock and meets nothing the cutter was not already clear of. It is added
  // before the WO-407 re-proof below, so the published-path guard sees it too.
  const finalMove = publishMoves[publishMoves.length - 1];
  if (finalMove !== undefined && finalMove.z < clearanceZ) {
    publishMoves = [...publishMoves, { t: 'rapid', role: 'rapid', x: finalMove.x, y: finalMove.y, z: clearanceZ }];
    smoothed = { ...smoothed, moves: publishMoves };
  }

  // WO-407: the traverse-safety verdict travels with the path that is
  // PUBLISHED. enforceTraverseSafety proved every low link and descent on the
  // dense planner polyline; smoothAdaptiveIr then fits lines/arcs up to
  // tolerance/4 off that polyline, so a shaft proven clear over the polyline's
  // cut can sit over a sub-tolerance sliver the fitted path leaves standing
  // (proofChannel.wo200: the descent at (27.009, 48.133) 16.05 -> 12.05 read
  // 3.95 mm once the arc replay was honest). Run the same guard once more over
  // the published moves on a stock replayed from those same moves (arcs
  // walked): an offending link is rerouted over clearance, an offending
  // descent is fed down from where the field stops vouching, everything else
  // is byte-identical. Whatever it changed is proven against the retained
  // model again before it can ship.
  if (publishMoves.length > 0) {
    reportProgress(0.95, 'Re-proving traverses on the published path', 0);
    const republished = enforceTraverseSafety(publishMoves, {
      stock: initialDisplayStock.clone(),
      cutter,
      clearanceZ,
      materialTopZ: input.materialTopZ,
      stockProven,
      initialTip: null,
    });
    // Only what the re-proof CHANGED is added to the counters (a reroute, a
    // descent fed down, a link lifted for headroom, the worst intrusion it
    // saw); its checks are the same links and descents the level guard already
    // counted once. The smallest air is merged as a minimum: the conservative
    // figure across every judgement, the published path's included.
    traverseRerouted += republished.report.rerouted;
    traverseReroutedHitMaterial += republished.report.reroutedHitMaterial;
    traverseReroutedUnprovable += republished.report.reroutedUnprovable;
    traverseDescentsFedDown += republished.report.descentsFedDown;
    traverseLiftedForHeadroom += republished.report.liftedForHeadroom;
    minLowTravelGapMm = Math.min(minLowTravelGapMm, republished.report.minLowTravelGapMm);
    worstTraverse = mergeWorstIntrusion(worstTraverse, republished.report);
    // WO-1270 (audit fix round): the guard has THREE ways to change the stream
    // now -- a reroute, a fed-down descent, and a headroom lift -- and every
    // one of them is a correction the published path has to keep. The lift is
    // exactly the window the smoothing pass can put a link into (a sub-tolerance
    // sliver under a link the level pass proved with the full headroom), so
    // dropping it here would ship the un-lifted path the console just said was
    // lifted.
    if (
      republished.report.rerouted > 0
      || republished.report.descentsFedDown > 0
      || republished.report.liftedForHeadroom > 0
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        `[traverse-reproof] published path: ${republished.report.rerouted} link(s) rerouted, `
        + `${republished.report.descentsFedDown} descent(s) fed down, `
        + `${republished.report.liftedForHeadroom} link(s) lifted for headroom`
        + (republished.report.worstWitness !== undefined
          ? `; worst ${republished.report.worstIntrusionMm.toFixed(3)} mm at ${republished.report.worstWitness}`
          : '')
        + ' (WO-407)',
      );
      await validateMoves(republished.moves);
      smoothed = { ...smoothed, moves: republished.moves };
      publishMoves = republished.moves;
    }
  }

  if (publishMoves.length > 0) {
    reportProgress(0.96, 'Checking entry engagement', 0);
    const overCapRuns: Array<{ role: string; z: number; x0: number; y0: number; x1: number; y1: number; len: number; max: number }> = [];
    // Replay the final path in its real order. Explicit full-level slab depths
    // keep interleaved midpoint Z values from changing bulk denominators; those
    // terrace moves were measured against live stock before acceptance and are
    // replayed here without being counted a second time.
    const fullLevelSlabDepths = new Map<number, number>();
    for (let index = 0; index < fullLevels.length; index++) {
      const above = index === 0 ? stockTopZ : fullLevels[index - 1];
      fullLevelSlabDepths.set(fullLevels[index], above - fullLevels[index]);
    }
    const engagement = measurePathEngagement(
      publishMoves,
      stockBounds,
      cellSize,
      cutter,
      // WO-1233: measure what is actually published after smoothing/safety
      // repair, for either entry mode.
      {
        capFraction: SIDE_ENTRY_ENGAGEMENT_CAP,
        ...(input.intermediateStepdown === true
          ? { slabDepthsByZ: fullLevelSlabDepths }
          : {}),
        // WO-1252. The replay's default starting field is an UNCUT BOX, and for a
        // rest job that is a fiction: the operation runs on what the previous
        // rough left, so charging it for material already gone reads 101% of a
        // full slot -- above the physical maximum, which is the measurement
        // announcing it is not a load figure. Measured on restFromRetainedStock
        // .wo277: 585.7mm of a 726.3mm path over the cap, in one unbroken
        // 124.8mm ride, against 2.5mm / 0.8mm from the field it actually starts
        // on. Now that the interior row REFUSES on this number (below), a
        // diagnostic would kill jobs that are fine.
        //
        // WO-1619 (SH-5): BOTH entry modes now. WO-1252 left side entry on the
        // uncut-box replay, and every second Adaptive 3D after a stock-boundary
        // rough refused on it: the 0.5 mm skin the rough left on the part top read
        // 104.6% of a full slot because the replay charged the path for all the
        // stock around the part that was already gone. The software can cut that
        // skin (rule 11). For every job that is not a rest job `initialDisplayStock`
        // IS `ZDexelField.fromBox(stockBounds, cellSize)`, so no other job moves.
        //
        // `initialDisplayStock` is the starting field cloned at line ~762 before
        // anything carves it; measurePathEngagement clones again for its replay.
        startingStock: initialDisplayStock,
        // Every over-cap window, grouped into runs, so a refusal can be read
        // without re-running the job (WO-409: the planner's own 2D measure and
        // this one must be compared window by window, not by the peak alone).
        // WO-1252: collected for BOTH entry modes. Interior entry can now
        // refuse, and a refusal that names a peak and no locations is one the
        // user cannot act on.
        onOverCap: (h) => {
          const last = overCapRuns[overCapRuns.length - 1];
          if (last && last.role === h.role && Math.abs(last.z - h.z) < 1e-6
            && Math.hypot(last.x1 - h.x, last.y1 - h.y) <= 3) {
            last.x1 = h.x; last.y1 = h.y; last.len += h.lengthMm; last.max = Math.max(last.max, h.fraction);
          } else {
            overCapRuns.push({ role: h.role, z: h.z, x0: h.x, y0: h.y, x1: h.x, y1: h.y, len: h.lengthMm, max: h.fraction });
          }
        },
      },
    );
    // WO-1252, the engagement contract, as TWO refusal rows plus a report row.
    // They are read in this order and each states its own precondition; there is
    // no single condition doing two jobs.
    if (engagement.peakFraction > SIDE_ENTRY_ENGAGEMENT_CAP) {
      const entryMode = input.sideEntry ? 'side-entry' : 'interior-entry';
      const lengthDigits = input.sideEntry ? 0 : 1;
      const message =
        `${entryMode} path exceeded the sustained engagement cap: peak ` +
        `${(engagement.peakFraction * 100).toFixed(1)}% of a full slot; ` +
        `${engagement.overCapLengthMm.toFixed(lengthDigits)}mm of ` +
        `${engagement.cuttingLengthMm.toFixed(lengthDigits)}mm cutting path over the ` +
        `${(SIDE_ENTRY_ENGAGEMENT_CAP * 100).toFixed(0)}% cap` +
        (engagement.peakAt
          ? ` (worst near X${engagement.peakAt.x.toFixed(1)} Y${engagement.peakAt.y.toFixed(1)} Z${engagement.peakAt.z.toFixed(1)})`
          : '');
      // A refusal the operator cannot act on is half a defect: name WHERE before
      // throwing, capped at 40 runs. Same line either mode has always printed.
      const warnOverCapRuns = (): void => {
        for (const r of overCapRuns.slice(0, 40)) {
          // eslint-disable-next-line no-console
          console.warn(`[${entryMode}] over-cap run: ${r.len.toFixed(1)} mm at up to ${(r.max * 100).toFixed(0)}% role ${r.role} z ${r.z.toFixed(2)} from (${r.x0.toFixed(2)}, ${r.y0.toFixed(2)}) to (${r.x1.toFixed(2)}, ${r.y1.toFixed(2)})`);
        }
      };

      // ROW 2a - SIDE ENTRY. Byte-identical to main: the quantity is the
      // WHOLE-PATH SUM (overCapLengthMm), not the longest run. This row has been
      // landed since WO-131 and is not this order's to move; loosening it to the
      // run would silently let through side-entry jobs that refuse today.
      if (input.sideEntry && engagement.overCapLengthMm > SIDE_ENTRY_MAX_TRANSIENT_OVER_CAP_MM) {
        warnOverCapRuns();
        fail(message);
      }

      // ROW 2b - INTERIOR ENTRY. The refusal this order exists to add. The
      // quantity is the longest UNBROKEN over-cap stretch, because that is what
      // endangers a cutter: one long buried ride, not four disjoint corner bites.
      // Measured on this branch, all interior, against the same 2 mm allowance
      // and each from the field its job actually starts on:
      //   10 mm ring, no bounded corridor   sum 331.7 mm   longest run 19.4 mm
      //   roughGateA A.5, real slotting     sum  29.6 mm   longest run 12.5 mm
      //   wo277/wo279, a valid rest job     sum   2.5 mm   longest run  0.8 mm
      // The sum refuses all three; the run refuses the two that are
      // cutter-breaking. The rest job's few millimetres are disjoint corner
      // nibbles across two levels -- the small cutter taking what the big one
      // could not reach, which is what rest machining IS -- and the cutter leaves
      // the material between every pair, so no number of them is a sustained
      // load. That is also what the message has always claimed to measure ("the
      // SUSTAINED engagement cap") and what the constant is named for (a
      // TRANSIENT allowance bounds how long ONE exceedance lasts). The cap (0.75)
      // and the allowance (2 mm) are untouched; only the quantity moved.
      if (!input.sideEntry && engagement.longestOverCapRunMm > SIDE_ENTRY_MAX_TRANSIENT_OVER_CAP_MM) {
        warnOverCapRuns();
        fail(message);
      }

      // ROW 1 - report, path still emitted. Interior only, exactly the jobs
      // WO-1233 built it for: side entry within its allowance has always been
      // silent here and this order changes nothing a side-entry job sees. The
      // tail moved with the measurement above - the interior replay now starts
      // from this operation's own stock, so calling it a diagnostic from an uncut
      // box would misdescribe the number the reader is looking at (WO-1252).
      if (!input.sideEntry) {
        // eslint-disable-next-line no-console
        console.warn(`[adaptive-rough] ${message}; replayed from this operation's starting stock`);
        opts?.onNotice?.(`${message}; the path was still generated.`);
      }
    }
  }

  opts?.onDiagnostics?.({ adaptiveRough: roughDiagnostics });

  // Chunk C3: the fully-carved stock field is otherwise discarded on return.
  // Hand it over exactly once (auxiliary to the IR) so the worker can mesh it
  // for the viewport carved-stock preview. Its z-dexel walls are cell-
  // staircased (true tri-dexel wall fidelity deferred, D-003).
  let publishedStock = displayStock;
  if (wallCleanupSafetyFallback) {
    // The rejected cleanup was already replayed into displayStock while it was
    // being evaluated. Rebuild from the operation's real input stock so the
    // simulation can never show removal that the published path will not make.
    publishedStock = initialDisplayStock.clone();
    replayMovesIntoStock(publishedStock, cutter, stockReplayMoves ?? publishMoves, null);
  }
  reportProgress(0.98, 'Finalizing carved stock', 0);
  opts?.onCarvedStock?.(publishedStock);
  if (opts?.onProgress) {
    const now = performance.now();
    if (progressRuntime.phase) {
      progressRuntime.phaseTimes.set(
        progressRuntime.phase,
        (progressRuntime.phaseTimes.get(progressRuntime.phase) ?? 0)
          + (now - progressRuntime.phaseStartedAt),
      );
    }
    progressRuntime.lastFraction = 1;
    opts.onProgress(1, {
      phase: 'Complete',
      phaseFraction: 1,
      elapsedMs: now - progressRuntime.startedAt,
      phaseElapsedMs: 0,
      attempt: progressAttempt + 1,
      ...(longestProgressPhase(progressRuntime)
        ? { longestPhase: longestProgressPhase(progressRuntime)! }
        : {}),
    });
  }

  return {
    moves: publishMoves,
    meta: {
      strategyId: 'adaptive_rough_zlevel',
      cutterId: cutterIdOf(cutter),
      params: {
        stepover,
        millingDirection: selectedMillingDirection,
        spindleRotation,
        wallLeadInRadius,
        wallLeadOutRadius,
        loopbackFilletPct,
        integralWallFollow,
        integralWallFollowLengthFactor,
        outsideEntry: input.sideEntry === true,
        outsideEntryCount: publishMoves.filter((move) => move.role === 'lead_in').length,
        maxStepdown,
        tolerance,
        helixDiameter,
        helixAngleDeg,
        radialStockToLeave,
        axialStockToLeave,
        // WO-316: the EFFECTIVE reach after the toolRadius clamp, not the raw
        // input -- so a caller can see whether its request was honoured as-is
        // or bounded.
        reachStockEdgeBy,
        cellSize,
        floorZ,
        levelCount: levels.length,
        ...(input.intermediateStepdown === true
          ? {
              intermediateStepdown: true,
              fullLevelCount: fullLevels.length,
              intermediateLevelCount: intermediateLevels.size,
              intermediateCandidateCount: plannedTerraces.length,
              intermediateEmittedCount: terraceEmitted,
              intermediateSkippedCount: terraceSkipped,
              intermediateConservativeFallbackCount: terraceConservativeFallbacks,
              intermediateRemovedVolumeMm3: terraceRemovedVolumeMm3,
              intermediateChangedAreaMm2: terraceChangedAreaMm2,
            }
          : {}),
        plannerCacheHits: levelPlanCache.hits,
        plannerCacheMisses: levelPlanCache.misses,
        plannerUniquePlans: levelPlanCache.uniquePlans,
        retainedWallProbeDiameter: retainedSafetyProbeDiameter ?? 0,
        smoothingRemovedPoints: smoothed.removedPoints,
        smoothingArcCount: smoothed.arcCount,
        smoothingSafetyFallback,
        wallCleanupSafetyFallback,
        wallContactCellSize: wallContactFrame.cell,
        wallCleanupContours,
        // WO-1253: wall left standing rather than ploughed, so a caller can show the
        // operator what this operation deliberately did not cut. Absent when nothing
        // was surrendered, so a clean job's params are unchanged.
        ...(wallRimOverloadSpans > 0
          ? { wallRimOverloadMm, wallRimOverloadSpans }
          : {}),
        // WO-096: the traverse-safety verdict travels with the path it describes.
        stockProven,
        // WO-277: so does the provenance of the stock it was planned against --
        // present only for a rest pass, so a from-the-box path is unchanged.
        ...(input.startFromStock !== undefined ? { startedFromRetainedStock: true } : {}),
        traverseChecked,
        traverseRerouted,
        traverseReroutedHitMaterial,
        traverseReroutedUnprovable,
        traverseDescentsChecked,
        traverseDescentsFedDown,
        // WO-1270: the headroom rule, visible on the path it governed.
        traverseLiftedForHeadroom,
        ...(Number.isFinite(minLowTravelGapMm) ? { minLowTravelGapMm } : {}),
        ...(Number.isFinite(worstTraverse.worstIntrusionMm)
          ? { worstTraverseIntrusionMm: worstTraverse.worstIntrusionMm }
          : {}),
        ...(worstTraverse.worstWitness !== undefined
          ? { worstTraverseWitness: worstTraverse.worstWitness }
          : {}),
      },
    },
  };
}
