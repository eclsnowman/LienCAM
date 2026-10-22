import type { Scallop3dParams } from '../../kernel/parameterTypes';
export type { Scallop3dParams } from '../../kernel/parameterTypes';
export { DEFAULT_SCALLOP3D_PARAMS } from '../../kernel/parameterDefaults';
export { readScallop3dParams } from '../../kernel/schema';
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
