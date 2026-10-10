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
  type ResolvedParallel3dHeights,
} from './parallel3dOperation';

export interface Pencil3dParams {
  tolerance: number;
  stockToLeave: number;
  useStockBoundary: boolean;
  finishDepth?: number;
  direction: 'climb' | 'conventional';
}

export const DEFAULT_PENCIL3D_PARAMS: Pencil3dParams = {
  tolerance: 0.05, stockToLeave: 0, useStockBoundary: false,
  finishDepth: undefined, direction: 'climb',
};

export function readPencil3dParams(params: Record<string, unknown>): Pencil3dParams {
  const positive = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  const nonNegative = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  return {
    tolerance: positive(params.tolerance, DEFAULT_PENCIL3D_PARAMS.tolerance),
    stockToLeave: nonNegative(params.stockToLeave, DEFAULT_PENCIL3D_PARAMS.stockToLeave),
    useStockBoundary: typeof params.useStockBoundary === 'boolean' ? params.useStockBoundary : false,
    finishDepth: positive(params.finishDepth, 0) || undefined,
    direction: params.direction === 'conventional' ? 'conventional' : 'climb',
  };
}

export interface ComputePencil3dArgs {
  partMesh: PartMesh; tool: Tool;
  feedrateOverride?: FeedrateOverride; params: Pencil3dParams;
  resolvedHeights: ResolvedParallel3dHeights; boundary?: readonly Ring[];
  /** WO-1223. BRep face ids this pass is aimed at; absent/empty = the whole part. */
  faceScope?: readonly number[];
  client: Cam3dClient; signal?: AbortSignal; onProgress?: (fraction: number) => void;
}

export async function computePencil3dMoves(args: ComputePencil3dArgs): Promise<{
  moves: ToolpathMove[]; computeTimeMs: number;
  /** WO-1540: what this generation substituted or left out, in plain words, for the app console. */
  notices?: string[];
}> {
  const cutter: CutterSpec = toolToCutterSpec(args.tool);
  const notices: string[] = [];
  const stockTopZ = args.resolvedHeights.stockTopZ;
  const heights: PathBuildHeights = {
    clearanceZ: args.resolvedHeights.clearanceZ, retractZ: args.resolvedHeights.retractZ,
    feedZ: args.resolvedHeights.feedZ, ...(stockTopZ !== undefined ? { materialTopZ: stockTopZ } : {}),
  };
  const zSeed = Math.min(args.partMesh.bounds.min[2], args.resolvedHeights.bottomZ);
  const boundary = await resolveFaceScopedBoundary({
    partMesh: args.partMesh,
    faceScope: args.faceScope,
    boundary: args.boundary,
    cutterRadius: cutterRadius(cutter),
    operationLabel: 'Pencil 3D',
    onNotice: message => { notices.push(message); },
  });
  const started = performance.now();
  const ir = await args.client.generatePencilFinish({
    partMesh: args.partMesh, cutter, tolerance: args.params.tolerance,
    stockToLeave: args.params.stockToLeave,
    ...(args.params.finishDepth !== undefined ? { minFinishZ: args.resolvedHeights.topZ - args.params.finishDepth } : {}),
    direction: args.params.direction, heights, zSeed,
    ...(boundary !== undefined ? { boundary } : { xyBounds: {
      minX: args.partMesh.bounds.min[0], minY: args.partMesh.bounds.min[1],
      maxX: args.partMesh.bounds.max[0], maxY: args.partMesh.bounds.max[1],
    } }),
  }, { signal: args.signal, onProgress: args.onProgress });
  const computeTimeMs = performance.now() - started;
  const feeds = Object.prototype.hasOwnProperty.call(args, 'feedrateOverride')
    ? resolveFeedrates(args.tool, args.feedrateOverride) : undefined;
  const moves = irToToolpathMoves(ir, feeds);
  if (moves.length === 0) throw new Error('pencil_3d produced no toolpath moves. No concave corner may be present.');
  return {
    moves, computeTimeMs,
    ...(notices.length > 0 ? { notices } : {}),
  };
}
