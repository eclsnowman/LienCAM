// cam3d integration (L6 bridge): one finish operation composed from the live
// waterline (steep) and parallel (shallow) operation adapters. No strategy or
// linker is copied here: each half keeps its existing worker and path builder.

import type { ToolpathMove } from '../../types';
import {
  computeParallel3dMoves,
  cutterRadius,
  resolveFaceScopedBoundary,
  type ComputeParallel3dArgs,
  type Parallel3dParams,
} from './parallel3dOperation';
import { toolToCutterSpec } from './cutterSpec';
import {
  computeWaterline3dMoves,
  type WaterlineParams,
} from './waterline3dOperation';

export interface SteepShallow3dParams {
  /** Angle from horizontal dividing steep waterlines from shallow raster passes. */
  thresholdDeg: number;
  stepdown: number;
  stepover: number;
  angleDeg: number;
  tolerance: number;
  stockToLeave: number;
  useStockBoundary: boolean;
  finishDepth?: number;
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
};

/** Total angular overlap around the threshold, preventing a witness band. */
export const STEEP_SHALLOW_OVERLAP_DEG = 2;

export function readSteepShallow3dParams(
  params: Record<string, unknown>,
): SteepShallow3dParams {
  const positive = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  const nonNegative = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  const rawThreshold = params.thresholdDeg;
  let threshold: number;
  if (typeof rawThreshold === 'number' && Number.isFinite(rawThreshold)) {
    // WO-1515 / BUG-422: an out-of-range angle clamps to the nearest valid
    // degree (the UI enforces the same 0-90 bound) rather than being silently
    // replaced by an unrelated default strategy split.
    threshold = Math.min(90, Math.max(0, rawThreshold));
    if (threshold !== rawThreshold) {
      console.warn(
        `steep_shallow_3d: thresholdDeg ${rawThreshold} is out of range [0, 90]; using ${threshold}.`,
      );
    }
  } else {
    threshold = DEFAULT_STEEP_SHALLOW3D_PARAMS.thresholdDeg;
  }
  return {
    thresholdDeg: threshold,
    stepdown: positive(params.stepdown, DEFAULT_STEEP_SHALLOW3D_PARAMS.stepdown),
    stepover: positive(params.stepover, DEFAULT_STEEP_SHALLOW3D_PARAMS.stepover),
    angleDeg: typeof params.angleDeg === 'number' && Number.isFinite(params.angleDeg)
      ? params.angleDeg
      : DEFAULT_STEEP_SHALLOW3D_PARAMS.angleDeg,
    tolerance: positive(params.tolerance, DEFAULT_STEEP_SHALLOW3D_PARAMS.tolerance),
    stockToLeave: nonNegative(params.stockToLeave, DEFAULT_STEEP_SHALLOW3D_PARAMS.stockToLeave),
    useStockBoundary: typeof params.useStockBoundary === 'boolean'
      ? params.useStockBoundary
      : DEFAULT_STEEP_SHALLOW3D_PARAMS.useStockBoundary,
    finishDepth: positive(params.finishDepth, 0) || undefined,
  };
}

export interface ComputeSteepShallow3dArgs
  extends Omit<ComputeParallel3dArgs, 'params' | 'onProgress'> {
  params: SteepShallow3dParams;
  onProgress?: (fraction: number) => void;
}

type FinishResult = {
  moves: ToolpathMove[];
  computeTimeMs: number;
  /** WO-1540: operator notices for the app console. */
  notices?: string[];
};

/** Put this composer's own notices ahead of a half's. */
function withNotices(own: readonly string[], result: FinishResult): FinishResult {
  const notices = [...own, ...(result.notices ?? [])];
  return notices.length > 0 ? { ...result, notices } : result;
}

function isEmptyHalf(error: unknown, family: 'waterline_3d' | 'parallel_3d'): boolean {
  return error instanceof Error && error.message.startsWith(`${family} produced no toolpath moves.`);
}

/**
 * Finish steep walls first, then shallow floors. Intermediate thresholds use a
 * one-degree overlap on each side (two degrees total); both strategies therefore
 * own the transition instead of leaving an angular witness strip. Threshold 0
 * and 90 bypass composition so their moves exactly match the corresponding
 * standalone operation.
 */
export async function computeSteepShallow3dMoves(
  args: ComputeSteepShallow3dArgs,
): Promise<FinishResult> {
  const { params } = args;
  // WO-1223: the face scope is resolved ONCE, here, and the halves receive the
  // finished containment. Both halves would otherwise resolve the identical
  // scope from the identical mesh and cutter (`toolToCutterSpec(args.tool)` in
  // each), which is not merely wasted work: the no-faceIds fallback and the
  // FaceScopeError refusal would each be reported TWICE for one operation the
  // operator ran once. Resolving up here also means the steep and shallow
  // regions cannot disagree about where the pass is allowed to cut, and the
  // console line names the operation the operator actually started.
  const ownNotices: string[] = [];
  const boundary = await resolveFaceScopedBoundary({
    partMesh: args.partMesh,
    faceScope: args.faceScope,
    boundary: args.boundary,
    cutterRadius: cutterRadius(toolToCutterSpec(args.tool)),
    operationLabel: 'Steep and Shallow',
    onNotice: message => { ownNotices.push(message); },
  });
  const shared = {
    partMesh: args.partMesh,
    tool: args.tool,
    ...(Object.prototype.hasOwnProperty.call(args, 'feedrateOverride')
      ? { feedrateOverride: args.feedrateOverride }
      : {}),
    resolvedHeights: args.resolvedHeights,
    boundary,
    // Already applied above. A half that resolved it again would rebuild the
    // identical region and re-report the identical fallback or refusal.
    faceScope: undefined,
    // WO-1271: say what the halves are getting. resolveFaceScopedBoundary
    // returns the caller's own reference when no scope applied, so a new
    // reference IS the inset selection region -- an edge the shallow half's
    // stock-edge overrun must never cross. Otherwise pass the caller's vouch
    // through unchanged.
    boundaryKind: boundary === args.boundary ? args.boundaryKind : 'selection',
    client: args.client,
    signal: args.signal,
  };
  const waterlineParams: WaterlineParams = {
    stepdown: params.stepdown,
    tolerance: params.tolerance,
    stockToLeave: params.stockToLeave,
    minSlopeDeg: 0,
    flatAreaDetection: true,
    order: 'region',
    direction: 'climb',
    useStockBoundary: params.useStockBoundary,
    finishDepth: params.finishDepth,
  };
  const parallelParams: Parallel3dParams = {
    stepover: params.stepover,
    angleDeg: params.angleDeg,
    tolerance: params.tolerance,
    surfaceStockToLeave: params.stockToLeave,
    useStockBoundary: params.useStockBoundary,
    finishDepth: params.finishDepth,
  };

  if (params.thresholdDeg === 0) {
    return withNotices(ownNotices, await computeWaterline3dMoves({
      ...shared,
      params: waterlineParams,
      onProgress: args.onProgress,
    }));
  }
  if (params.thresholdDeg === 90) {
    return withNotices(ownNotices, await computeParallel3dMoves({
      ...shared,
      params: parallelParams,
      onProgress: args.onProgress,
    }));
  }

  const halfOverlap = STEEP_SHALLOW_OVERLAP_DEG / 2;
  waterlineParams.minSlopeDeg = Math.max(0, params.thresholdDeg - halfOverlap);
  parallelParams.maxSlopeDeg = Math.min(90, params.thresholdDeg + halfOverlap);

  let steep: FinishResult | undefined;
  try {
    steep = await computeWaterline3dMoves({
      ...shared,
      params: waterlineParams,
      onProgress: args.onProgress ? fraction => args.onProgress!(fraction * 0.5) : undefined,
    });
  } catch (error) {
    if (!isEmptyHalf(error, 'waterline_3d')) throw error;
  }

  let shallow: FinishResult | undefined;
  try {
    shallow = await computeParallel3dMoves({
      ...shared,
      params: parallelParams,
      onProgress: args.onProgress ? fraction => args.onProgress!(0.5 + fraction * 0.5) : undefined,
    });
  } catch (error) {
    if (!isEmptyHalf(error, 'parallel_3d')) throw error;
  }

  if (!steep && !shallow) {
    throw new Error('steep_shallow_3d produced no toolpath moves; both finish regions were empty.');
  }
  return withNotices([...ownNotices, ...(steep?.notices ?? [])], {
    moves: [...(steep?.moves ?? []), ...(shallow?.moves ?? [])],
    computeTimeMs: (steep?.computeTimeMs ?? 0) + (shallow?.computeTimeMs ?? 0),
    ...(shallow?.notices ? { notices: shallow.notices } : {}),
  });
}
