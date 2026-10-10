// cam3d integration (L6 bridge): the waterline_3d operation adapter (WO-1176).
//
// Mirrors parallel3dOperation.ts one-to-one: the store (browser) resolves the
// source solid, heights and boundary and hands them here; everything
// cam3d-specific (CutterSpec, PathBuildHeights + zSeed, the client call, IR ->
// ToolpathMove[]) lives in this one place, dependency-injected so it is
// headless-testable without the zustand store or IndexedDB.
//
// Two things a waterline has that a raster finish does not, both here:
//   - the SIZE NOTICE. WO-284 measured the shipped wasm slicer aborting the
//     whole module at a footprint / sampling ratio somewhere between 1800
//     (safe) and 2000 (dead), independent of triangle count. A part past that
//     is sliced in XY tiles that each fit (kernel/waterlineTiles.ts, WO-2638);
//     this bridge says so in one line on the app console. Nothing is refused
//     for size.
//   - a POISONED LIBRARY. If the slicer still aborts (the ratio is a measured
//     floor, not a proof), the worker answers with an error named
//     `OclModulePoisoned`; this bridge rethrows it under the same name so the
//     store can recycle the cam3d worker before the next compute.
//
// Layering: an L6 bridge may import src/types, the cam3d client, cam3d/input
// and geom2d. It never reaches into strategy/kernel internals.
//
// Determinism (D-006): the returned moves are byte-identical for identical
// inputs; `computeTimeMs` is diagnostic only.

import type { CutterSpec, PartMesh } from '../kernel/types';
import type { PathBuildHeights } from '../pathbuild';
import type { Ring } from '../geom2d';
import type { Cam3dClient } from '../worker/client';
import { irToToolpathMoves } from '../ir/toToolpathMoves';
import { waterlineSamplingFor } from '../kernel/oclWaterline';
import { waterlineTilePlan, WATERLINE_MAX_FOOTPRINT_SAMPLING_RATIO } from '../kernel/waterlineTiles';
import type { FeedrateOverride, ToolpathMove, Tool } from '../../types';
import { resolveFeedrates } from '../../lib/cam/feedrates';
import { spindleRotationForTool } from '../../lib/tool/cutHand';
import { toolToCutterSpec } from './cutterSpec';
import {
  cutterRadius,
  resolveFaceScopedBoundary,
  resolveStockEdgeOverrun,
  type ResolvedParallel3dHeights,
} from './parallel3dOperation';

/** The parameters a waterline_3d op carries in `op.params`. The dialog reads/writes exactly these. */
export interface WaterlineParams {
  /** Maximum stepdown between levels, mm (> 0); the last step may be shorter. */
  stepdown: number;
  /** Max chordal deviation, mm (> 0). Drives the slicer sampling (kernel/oclWaterline.ts). */
  tolerance: number;
  /** Radial allowance on the walls, mm (>= 0). A ball cutter's is a true surface offset. */
  stockToLeave: number;
  /** Steep areas only: 0 = whole part; else drop runs shallower than this angle from horizontal. */
  minSlopeDeg: number;
  /** Add a level at every horizontal face. */
  flatAreaDetection: boolean;
  /** Level-first ("order by depth") or region-first ("order by islands"). */
  order: 'level' | 'region';
  direction: 'climb' | 'conventional';
  /** Optional maximum finish depth below model top, mm (Smart Height bounded variant). */
  finishDepth?: number;
  /** Clip passes to the stock footprint (true) or leave the part silhouette (false). */
  useStockBoundary: boolean;
  /** Stock-edge overrun in mm; undefined = auto tool radius, 0 = legacy containment. */
  stockEdgeOvershoot?: number;
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
};

/**
 * The stepdown a fresh operation starts with for a given tool: 10% of the
 * diameter, never under 0.2 mm (the research: finishing stepovers of 8-12%
 * of diameter are the shared guidance; a waterline stepdown is set the same).
 */
export function defaultWaterlineStepdownFor(toolDiameter: number): number {
  if (!(toolDiameter > 0) || !Number.isFinite(toolDiameter)) return DEFAULT_WATERLINE_PARAMS.stepdown;
  return Math.max(0.2, Math.round(toolDiameter * 0.1 * 100) / 100);
}

/**
 * Read a WaterlineParams out of an untyped `op.params` record, filling any
 * missing/invalid field from the defaults (fail-soft on shape, like the
 * parallel and adaptive readers).
 */
export function readWaterlineParams(params: Record<string, unknown>): WaterlineParams {
  const num = (v: unknown, fallback: number, mustBePositive: boolean): number => {
    if (typeof v === 'number' && Number.isFinite(v) && (!mustBePositive || v > 0)) return v;
    return fallback;
  };
  const optionalPositive = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  const slope = num(params.minSlopeDeg, DEFAULT_WATERLINE_PARAMS.minSlopeDeg, false);
  return {
    stepdown: num(params.stepdown, DEFAULT_WATERLINE_PARAMS.stepdown, true),
    tolerance: num(params.tolerance, DEFAULT_WATERLINE_PARAMS.tolerance, true),
    stockToLeave: Math.max(0, num(params.stockToLeave, DEFAULT_WATERLINE_PARAMS.stockToLeave, false)),
    minSlopeDeg: slope >= 0 && slope < 90 ? slope : DEFAULT_WATERLINE_PARAMS.minSlopeDeg,
    flatAreaDetection: typeof params.flatAreaDetection === 'boolean'
      ? params.flatAreaDetection : DEFAULT_WATERLINE_PARAMS.flatAreaDetection,
    order: params.order === 'level' ? 'level' : 'region',
    direction: params.direction === 'conventional' ? 'conventional' : 'climb',
    finishDepth: optionalPositive(params.finishDepth),
    useStockBoundary: typeof params.useStockBoundary === 'boolean'
      ? params.useStockBoundary : DEFAULT_WATERLINE_PARAMS.useStockBoundary,
    stockEdgeOvershoot:
      typeof params.stockEdgeOvershoot === 'number' &&
      Number.isFinite(params.stockEdgeOvershoot) && params.stockEdgeOvershoot >= 0
        ? params.stockEdgeOvershoot
        : undefined,
  };
}

export { WATERLINE_MAX_FOOTPRINT_SAMPLING_RATIO };

/**
 * The one console line for a part the slicer takes in tiles (WO-2638), or
 * null when it fits in one piece. `cutterRadius` is the slicing radius: the
 * tool's plus the stock to leave, as the strategy enlarges it. Pure
 * arithmetic over the mesh bounds; the slicer makes the same plan.
 */
export function waterlineTileNotice(
  partMesh: PartMesh,
  tolerance: number,
  cutterRadius: number,
): string | null {
  const { sampling } = waterlineSamplingFor(tolerance);
  const plan = waterlineTilePlan(partMesh.bounds, cutterRadius, sampling);
  if (plan === null) return null;
  // Only a cutter hundreds of fibres wide makes the plan coarsen the spacing.
  const at = plan.sampling === sampling
    ? 'at the full tolerance'
    : `at ${plan.sampling} mm fibre spacing (the cutter is too wide for a tile at ${sampling} mm)`;
  return (
    `the part is ${plan.footprint.toFixed(1)} mm across, more than the waterline slicer takes in one piece at ` +
    `the ${tolerance} mm tolerance (${(WATERLINE_MAX_FOOTPRINT_SAMPLING_RATIO * sampling).toFixed(0)} mm), so it was ` +
    `sliced in ${plan.nx} x ${plan.ny} tiles ${at} and the loops joined at the seams.`
  );
}

export interface ComputeWaterline3dArgs {
  partMesh: PartMesh;
  tool: Tool;
  feedrateOverride?: FeedrateOverride;
  params: WaterlineParams;
  /** The same shape Parallel Finish resolves: local frame, with the finishing band as top/bottom. */
  resolvedHeights: ResolvedParallel3dHeights;
  boundary?: readonly Ring[];
  /**
   * What `boundary` is, vouched by the caller. A stock outline may be
   * overrun; a selection region is a hard wall even when the operation's
   * stock-clipping checkbox is enabled.
   */
  boundaryKind?: 'stock' | 'selection';
  /** WO-1223. BRep face ids this pass is aimed at; absent/empty = the whole part. */
  faceScope?: readonly number[];
  client: Cam3dClient;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/**
 * Compute the waterline_3d toolpath moves through the cam3d worker.
 *
 * Material Start is the resolved top plane and Cutter End the resolved bottom
 * plane (the target-model surface or the finish-depth limit, from the Smart
 * Height policy). zSeed for the probes is the lower of the mesh bottom and
 * the resolved bottom, exactly as the raster finish seeds its drop floor.
 */
export async function computeWaterline3dMoves(
  args: ComputeWaterline3dArgs,
): Promise<{
  moves: ToolpathMove[];
  computeTimeMs: number;
  /** WO-1540: what this generation substituted or left out, in plain words, for the app console. */
  notices?: string[];
}> {
  const cutter: CutterSpec = toolToCutterSpec(args.tool);
  const notices: string[] = [];
  const onNotice = (message: string) => { notices.push(message); };
  const sampling = waterlineSamplingFor(args.params.tolerance);
  const tiled = waterlineTileNotice(
    args.partMesh, args.params.tolerance, cutterRadius(cutter) + args.params.stockToLeave,
  );
  if (tiled !== null) onNotice(tiled);

  const stockTopZ = args.resolvedHeights.stockTopZ;
  if (stockTopZ === undefined) {
    console.warn(
      '[waterline3d] no proven stock top: traverse safety falls back to the authored ' +
        `clearance z=${args.resolvedHeights.clearanceZ} (part top z=${args.resolvedHeights.topZ}). ` +
        'Rapids are NOT proven clear of uncleared stock above the part.',
    );
    onNotice(
      `no stock top was proven, so rapids use the authored clearance height (z=${args.resolvedHeights.clearanceZ}) ` +
        'and are not proven clear of uncut stock above the part.',
    );
  }
  const heights: PathBuildHeights = {
    clearanceZ: args.resolvedHeights.clearanceZ,
    retractZ: args.resolvedHeights.retractZ,
    feedZ: args.resolvedHeights.feedZ,
    ...(stockTopZ !== undefined ? { materialTopZ: stockTopZ } : {}),
  };
  const zSeed = Math.min(args.partMesh.bounds.min[2], args.resolvedHeights.bottomZ) - 1;
  const boundary = await resolveFaceScopedBoundary({
    partMesh: args.partMesh,
    faceScope: args.faceScope,
    boundary: args.boundary,
    cutterRadius: cutterRadius(cutter),
    operationLabel: 'Waterline 3D',
    onNotice,
  });
  // Waterline only needs an overrun when it has a real containment. Part-bounds
  // mode already follows the slicer's full cutter-centre contour. A non-empty
  // face scope remains a wall; only the caller can vouch that an otherwise
  // supplied containment is a stock outline rather than a selection region.
  const overrun = boundary === undefined
    ? { overrunMm: 0, reason: 'no containment: the full waterline is already kept' }
    : await resolveStockEdgeOverrun({
        cutterRadius: cutterRadius(cutter),
        stockEdgeOvershoot: args.params.stockEdgeOvershoot,
        faceScope: args.faceScope,
        boundary,
        // The standalone store path predates boundaryKind and only supplies
        // `boundary` when useStockBoundary resolved proven stock. Composed
        // callers provide the explicit vouch, which must take precedence.
        boundaryKind: args.boundaryKind ?? (args.params.useStockBoundary ? 'stock' : undefined),
        xyBounds: {
          minX: args.partMesh.bounds.min[0], minY: args.partMesh.bounds.min[1],
          maxX: args.partMesh.bounds.max[0], maxY: args.partMesh.bounds.max[1],
        },
      });

  const t0 = performance.now();
  let ir;
  try {
    ir = await args.client.generateWaterline(
      {
        partMesh: args.partMesh,
        cutter,
        stepdown: args.params.stepdown,
        sampling,
        stockToLeave: args.params.stockToLeave,
        minSlopeDeg: args.params.minSlopeDeg,
        flatAreaDetection: args.params.flatAreaDetection,
        order: args.params.order,
        direction: args.params.direction,
        spindle: spindleRotationForTool(args.tool),
        topZ: args.resolvedHeights.topZ,
        bottomZ: args.resolvedHeights.bottomZ,
        heights,
        zSeed,
        ...(boundary !== undefined ? { boundary } : {}),
        ...(overrun.rings !== undefined ? { overrunBoundary: overrun.rings } : {}),
      },
      { signal: args.signal, onProgress: args.onProgress },
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'OclModulePoisoned') {
      const poisoned = new Error(err.message);
      poisoned.name = 'OclModulePoisoned';
      throw poisoned;
    }
    throw err;
  }
  const computeTimeMs = performance.now() - t0;

  const resolvedFeeds = Object.prototype.hasOwnProperty.call(args, 'feedrateOverride')
    ? resolveFeedrates(args.tool, args.feedrateOverride)
    : undefined;
  const moves = irToToolpathMoves(ir, resolvedFeeds);
  if (moves.length === 0) {
    throw new Error(
      'waterline_3d produced no toolpath moves. The finishing band may miss the part, or the ' +
        'steep-areas-only angle or boundary may exclude every loop.',
    );
  }

  return {
    moves,
    computeTimeMs,
    ...(notices.length > 0 ? { notices } : {}),
  };
}
