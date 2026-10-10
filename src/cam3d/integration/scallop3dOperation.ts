import type { CutterSpec, PartMesh } from '../kernel/types';
import type { PathBuildHeights } from '../pathbuild';
import type { Ring } from '../geom2d';
import type { Cam3dClient } from '../worker/client';
import { irToToolpathMoves } from '../ir/toToolpathMoves';
import type { FeedrateOverride, ToolpathMove, Tool } from '../../types';
import { resolveFeedrates } from '../../lib/cam/feedrates';
import { toolToCutterSpec } from './cutterSpec';
import {
  cutterRadius,
  resolveFaceScopedBoundary,
  resolveStockEdgeOverrun,
  type ResolvedParallel3dHeights,
} from './parallel3dOperation';

export interface Scallop3dParams {
  scallopHeight: number;
  tolerance: number;
  stockToLeave: number;
  useStockBoundary: boolean;
  finishDepth?: number;
  direction: 'climb' | 'conventional';
  /**
   * WO-1282. Stock-edge overrun: mm PAST the containment edge the tool CENTRE
   * may travel, so the round cutter clears the edge instead of stopping with
   * its axis on it and leaving one radius of material behind. Same name, same
   * semantics and the SAME decision function as Parallel Finish 3D and
   * Adaptive Rough 3D carry (ADR-0015 s2 is one cross-cutting convention, not
   * four spellings): undefined = AUTO (the tool radius), 0 = none (the
   * pre-WO-1282 toolpath). Never applied to a face-scoped pass (WO-1223) or to
   * a boundary the caller has not vouched for as a stock outline.
   */
  stockEdgeOvershoot?: number;
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
};

export function readScallop3dParams(params: Record<string, unknown>): Scallop3dParams {
  const positive = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  const nonNegative = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  return {
    scallopHeight: positive(params.scallopHeight, DEFAULT_SCALLOP3D_PARAMS.scallopHeight),
    tolerance: positive(params.tolerance, DEFAULT_SCALLOP3D_PARAMS.tolerance),
    stockToLeave: nonNegative(params.stockToLeave, DEFAULT_SCALLOP3D_PARAMS.stockToLeave),
    useStockBoundary: typeof params.useStockBoundary === 'boolean'
      ? params.useStockBoundary : DEFAULT_SCALLOP3D_PARAMS.useStockBoundary,
    finishDepth: positive(params.finishDepth, 0) || undefined,
    direction: params.direction === 'conventional' ? 'conventional' : 'climb',
    // Optional non-negative: a finite >= 0 value wins; anything else ->
    // undefined (AUTO), so every scallop op authored before WO-1282 gets the
    // tool radius, exactly as readParallel3dParams does.
    stockEdgeOvershoot:
      typeof params.stockEdgeOvershoot === 'number' &&
      Number.isFinite(params.stockEdgeOvershoot) &&
      params.stockEdgeOvershoot >= 0
        ? params.stockEdgeOvershoot
        : undefined,
  };
}

export interface ComputeScallop3dArgs {
  partMesh: PartMesh;
  tool: Tool;
  feedrateOverride?: FeedrateOverride;
  params: Scallop3dParams;
  resolvedHeights: ResolvedParallel3dHeights;
  boundary?: readonly Ring[];
  /**
   * WO-1282. What `boundary` IS, vouched by the caller: 'stock' = the proven
   * stock outline (nothing beyond it but air; the stock-edge overrun applies),
   * 'selection' = a region already inset by the radius (its edge is a wall;
   * never overrun). A caller-provided boundary with NO vouch gets no overrun
   * and one console line saying so -- the safe failure. Forgetting this field
   * can cost a fin; it can never cost a gouge. Ignored when `boundary` is
   * undefined (part bounds, the adapter's own authority).
   */
  boundaryKind?: 'stock' | 'selection';
  /** WO-1223. BRep face ids this pass is aimed at; absent/empty = the whole part. */
  faceScope?: readonly number[];
  client: Cam3dClient;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

function xyBoundsFromMesh(mesh: PartMesh): {
  minX: number; minY: number; maxX: number; maxY: number;
} {
  return {
    minX: mesh.bounds.min[0], minY: mesh.bounds.min[1],
    maxX: mesh.bounds.max[0], maxY: mesh.bounds.max[1],
  };
}

export async function computeScallop3dMoves(args: ComputeScallop3dArgs): Promise<{
  moves: ToolpathMove[];
  computeTimeMs: number;
  /** WO-1540: what this generation substituted or left out, in plain words, for the app console. */
  notices?: string[];
}> {
  const cutter: CutterSpec = toolToCutterSpec(args.tool);
  const notices: string[] = [];
  const onNotice = (message: string) => { notices.push(message); };
  const stockTopZ = args.resolvedHeights.stockTopZ;
  if (stockTopZ === undefined) {
    console.warn(
      '[scallop3d] no proven stock top: traverse safety falls back to the authored ' +
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
  const zSeed = Math.min(args.partMesh.bounds.min[2], args.resolvedHeights.bottomZ);
  const containment = await resolveFaceScopedBoundary({
    partMesh: args.partMesh,
    faceScope: args.faceScope,
    boundary: args.boundary,
    cutterRadius: cutterRadius(cutter),
    operationLabel: 'Scallop 3D',
    onNotice,
  });
  // -------------------------------------------------------------------------
  // WO-1282: the stock-edge overrun, carried across to constant scallop.
  //
  // WHEN it applies is exactly WO-1271's judgement, so it is exactly
  // WO-1271's function: a face scope is a wall and never overruns, a
  // caller's boundary is overrun only on a 'stock' vouch, auto is one tool
  // radius less the tangent margin, 0 is none. One convention, one spelling.
  //
  // WHAT it produces is where scallop parts company with parallel. Parallel
  // clips SCANLINES, so its overrun is a second region: the lattice stays
  // anchored on the containment extent and interior passes come out
  // byte-identical. Scallop's geometry is a geodesic distance field whose
  // seeds are the cutter-contact silhouette (WO-1281); there is no lattice to
  // anchor, and the region is the single thing the grid, the seeds and every
  // contour level are derived from. Handing the strategy two regions would
  // only make it pick this one. So the overrun IS the containment region here,
  // and the honest identity claim is narrower: overshoot 0 reproduces the
  // pre-WO-1282 toolpath exactly, and with the overrun on the contours move by
  // design. What still holds is that the cut only grows outward and that
  // WO-1281's contact mask -- not this number -- is what bounds the band at one
  // cutter radius, whatever overshoot is asked for.
  // -------------------------------------------------------------------------
  const overrun = await resolveStockEdgeOverrun({
    cutterRadius: cutterRadius(cutter),
    stockEdgeOvershoot: args.params.stockEdgeOvershoot,
    faceScope: args.faceScope,
    boundary: containment,
    boundaryKind: args.boundaryKind,
    xyBounds: xyBoundsFromMesh(args.partMesh),
  });
  if (overrun.unvouched) {
    // ADR-0003: a capability withheld for want of information is said out loud.
    console.warn(`[scallop3d] stock-edge overrun: ${overrun.reason}.`);
    onNotice(
      'the stock-edge overrun was not applied because the boundary was not confirmed as the stock outline, ' +
      'so a fin may be left at the edge.',
    );
  }
  const boundary = overrun.rings ?? containment;
  const started = performance.now();
  const ir = await args.client.generateScallopFinish({
    partMesh: args.partMesh,
    cutter,
    scallopHeight: args.params.scallopHeight,
    tolerance: args.params.tolerance,
    surfaceStockToLeave: args.params.stockToLeave,
    ...(args.params.finishDepth !== undefined
      ? { minFinishZ: args.resolvedHeights.topZ - args.params.finishDepth }
      : {}),
    direction: args.params.direction,
    heights,
    zSeed,
    ...(boundary !== undefined ? { boundary } : { xyBounds: xyBoundsFromMesh(args.partMesh) }),
  }, { signal: args.signal, onProgress: args.onProgress, onNotice });
  const computeTimeMs = performance.now() - started;
  const resolvedFeeds = Object.prototype.hasOwnProperty.call(args, 'feedrateOverride')
    ? resolveFeedrates(args.tool, args.feedrateOverride) : undefined;
  const moves = irToToolpathMoves(ir, resolvedFeeds);
  if (moves.length === 0) throw new Error('scallop_3d produced no toolpath moves. The containment region may be empty.');
  return {
    moves,
    computeTimeMs,
    ...(notices.length > 0 ? { notices } : {}),
  };
}
