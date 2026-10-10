import type { CutterSpec, PartMesh } from '../kernel/types';
import type { Ring } from '../geom2d';
import type { Box3, LinearMove } from '../stock';
import type { Cam3dClient } from '../worker/client';
import { irToToolpathMoves } from '../ir/toToolpathMoves';
import type { FeedrateOverride, OperationStatus, ToolpathMove, Tool } from '../../types';
import { resolveFeedrates } from '../../lib/cam/feedrates';
import { deriveCellSize } from './adaptive3dOperation';
import { toolToCutterSpec } from './cutterSpec';
import type { ResolvedParallel3dHeights } from './parallel3dOperation';
import { spindleRotationForTool } from '../../lib/tool/cutHand';
import { forEachLinearSweep, toolpathMovesToLinearSweeps, type ToolTipPosition } from '../rough/replayStock';
import { effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles';

export type RestMachiningStockSource = 'previous_operations' | 'previous_tool';

export interface RestMachiningSettings {
  restMachining: boolean;
  stockSource: RestMachiningStockSource;
}

export const DEFAULT_REST_MACHINING_SETTINGS: RestMachiningSettings = {
  restMachining: false,
  stockSource: 'previous_operations',
};

export function readRestMachiningSettings(params: Record<string, unknown>): RestMachiningSettings {
  return {
    restMachining: params.restMachining === true,
    stockSource: params.stockSource === 'previous_tool' ? 'previous_tool' : 'previous_operations',
  };
}

export interface RestMachiningAvailability {
  available: boolean;
  reason?: string;
}

/** The UI and compute path share the same authored-order readiness rule. */
export function restMachiningAvailability(
  operations: readonly (Pick<Rest3dPrecedingOperation, 'id' | 'name' | 'enabled' | 'status'> & {
    toolpathMoves?: readonly ToolpathMove[];
  })[],
  operationId?: string,
): RestMachiningAvailability {
  const currentIndex = operationId === undefined
    ? operations.length
    : operations.findIndex(operation => operation.id === operationId);
  if (currentIndex <= 0) {
    return { available: false, reason: 'Rest machining needs an earlier enabled operation in this setup.' };
  }
  const preceding = operations.slice(0, currentIndex).filter(operation => operation.enabled);
  if (preceding.length === 0) {
    return { available: false, reason: 'Rest machining needs an earlier enabled operation in this setup.' };
  }
  const uncomputed = preceding.find(operation =>
    operation.status !== 'ready' || operation.toolpathMoves === undefined,
  );
  if (uncomputed) {
    return {
      available: false,
      reason: `Rest machining needs preceding operation "${uncomputed.name}" to be computed first.`,
    };
  }
  return { available: true };
}

export interface Rest3dParams {
  stockSource: RestMachiningStockSource;
  referenceToolDiameter: number;
  referenceCornerRadius: number;
  tolerance: number;
  stockToLeave: number;
  stepdown: number;
  useStockBoundary: boolean;
  direction: 'climb' | 'conventional';
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

export function readRest3dParams(params: Record<string, unknown>): Rest3dParams {
  const positive = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  const nonNegative = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  return {
    // Missing/unrecognized resolves the same way readRestMachiningSettings does:
    // only an explicit 'previous_tool' opts out of the previous_operations default.
    stockSource: params.stockSource === 'previous_tool' ? 'previous_tool' : 'previous_operations',
    referenceToolDiameter: positive(params.referenceToolDiameter, DEFAULT_REST3D_PARAMS.referenceToolDiameter),
    referenceCornerRadius: nonNegative(params.referenceCornerRadius, DEFAULT_REST3D_PARAMS.referenceCornerRadius),
    tolerance: positive(params.tolerance, DEFAULT_REST3D_PARAMS.tolerance),
    stockToLeave: nonNegative(
      params.stockToLeave,
      nonNegative(params.surfaceStockToLeave, DEFAULT_REST3D_PARAMS.stockToLeave),
    ),
    stepdown: positive(params.stepdown, DEFAULT_REST3D_PARAMS.stepdown),
    useStockBoundary: typeof params.useStockBoundary === 'boolean' ? params.useStockBoundary : false,
    direction: params.direction === 'conventional' ? 'conventional' : 'climb',
  };
}

/** Runtime snapshot of one setup operation before the operation being planned. */
export interface Rest3dPrecedingOperation {
  id: string;
  name: string;
  enabled: boolean;
  status: OperationStatus;
  tool: Tool | undefined;
  toolpathMoves: readonly ToolpathMove[] | undefined;
}

export interface ComputeRest3dArgs {
  partMesh: PartMesh;
  tool: Tool;
  stockBounds: Box3;
  feedrateOverride?: FeedrateOverride;
  params: Rest3dParams;
  resolvedHeights: ResolvedParallel3dHeights;
  boundary?: readonly Ring[];
  /** Complete setup prefix in authored order; required by previous_operations. */
  precedingOperations?: readonly Rest3dPrecedingOperation[];
  client: Cam3dClient;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export async function computeRest3dMoves(args: ComputeRest3dArgs): Promise<{
  moves: ToolpathMove[]; computeTimeMs: number;
}> {
  const cutter: CutterSpec = toolToCutterSpec(args.tool);
  if (cutter.kind !== 'flat' && cutter.kind !== 'ball') {
    throw new Error('Rest 3D needs a flat or ball end mill.');
  }
  const usesPreviousOperations = args.params.stockSource === 'previous_operations';
  let referenceCutter: CutterSpec;
  let preceding: Array<{ operation: Rest3dPrecedingOperation; cutter: CutterSpec }> = [];
  if (usesPreviousOperations) {
    const enabled = (args.precedingOperations ?? []).filter(operation => operation.enabled);
    if (enabled.length === 0) {
      throw new Error('Rest machining from previous operations needs at least one enabled preceding operation.');
    }
    preceding = enabled.map(operation => {
      if (operation.status !== 'ready' || operation.toolpathMoves === undefined) {
        throw new Error(
          `Rest machining cannot use preceding operation "${operation.name}" (${operation.id}): ` +
          'its toolpath is not ready. Compute it before this operation.',
        );
      }
      if (operation.tool === undefined) {
        throw new Error(
          `Rest machining cannot use preceding operation "${operation.name}" (${operation.id}): ` +
          'its selected tool is unavailable.',
        );
      }
      const precedingCutter = toolToCutterSpec(operation.tool);
      if (precedingCutter.kind !== 'flat' && precedingCutter.kind !== 'ball') {
        throw new Error(
          `Rest machining cannot replay preceding operation "${operation.name}" (${operation.id}): ` +
          'stock replay currently supports flat or ball end mills.',
        );
      }
      return { operation, cutter: precedingCutter };
    });
    // restFinish still uses this nominal diameter to size its entry helix. The
    // replayed field, not this scalar, is the remaining-stock authority.
    const largestDiameter = Math.max(...preceding.map(item => item.cutter.diameter));
    referenceCutter = { kind: 'flat', diameter: Math.max(largestDiameter, cutter.diameter * 2) };
  } else {
    if (!(args.params.referenceToolDiameter > cutter.diameter)) {
      throw new Error('Reference tool diameter must be greater than this operation\'s cutter diameter.');
    }
    referenceCutter = args.params.referenceCornerRadius === 0
      ? { kind: 'flat', diameter: args.params.referenceToolDiameter }
      : Math.abs(args.params.referenceCornerRadius - args.params.referenceToolDiameter / 2) <= 1e-9
        ? { kind: 'ball', diameter: args.params.referenceToolDiameter }
        : (() => { throw new Error('Intermediate bull-nose reference tools are not supported by the stock sweep yet; use a flat or ball reference tool.'); })();
  }
  const cellSize = deriveCellSize(args.params.tolerance, cutter.diameter);
  const spindleRotation = spindleRotationForTool(args.tool);
  const started = performance.now();
  const commonRough = {
    partMesh: args.partMesh,
    stockBounds: args.stockBounds,
    cellSize,
    maxStepdown: args.params.stepdown,
    stepover: 0.4,
    millingDirection: args.params.direction,
    spindleRotation,
    wallLeadInRadius: 0,
    wallLeadOutRadius: 0,
    loopbackFilletPct: 25,
    integralWallFollow: true,
    integralWallFollowLengthFactor: 2,
    tolerance: args.params.tolerance,
    helixDiameter: Math.max(args.params.tolerance, Math.min(cutter.diameter, referenceCutter.diameter) * 0.6),
    helixAngleDeg: 10,
    heights: {
      clearanceZ: args.resolvedHeights.clearanceZ,
      retractZ: args.resolvedHeights.retractZ,
      feedZ: args.resolvedHeights.feedZ,
    },
    materialTopZ: args.stockBounds.maxZ,
    floorZ: args.resolvedHeights.bottomZ,
    stockBoundsAreRealStock: true as const,
    ...(args.boundary !== undefined ? { boundary: args.boundary } : {}),
  };
  let previousToolSweeps: LinearMove[] | undefined;
  if (!usesPreviousOperations) {
    const reference = await args.client.generateAdaptiveRough({
      ...commonRough,
      cutter: referenceCutter,
    }, {
      signal: args.signal,
      onProgress: fraction => args.onProgress?.(fraction * 0.35),
    });
    if (reference.carvedStockHandle !== undefined) {
      await args.client.stockDispose(reference.carvedStockHandle);
    }

    previousToolSweeps = [];
    let tip: ToolTipPosition | undefined;
    for (const move of reference.ir.moves) {
      const role = effectiveMoveRole({ type: move.t === 'rapid' ? 'rapid' : 'feed', role: move.role });
      if (tip !== undefined && isStockCuttingRole(role)) {
        forEachLinearSweep(tip, move, cellSize / 4, sweep => previousToolSweeps!.push(sweep));
      }
      tip = { x: move.x, y: move.y, z: move.z };
    }
  }

  const created = await args.client.stockCreate(args.stockBounds, cellSize);
  let ir;
  try {
    if (usesPreviousOperations) {
      for (const { operation, cutter: operationCutter } of preceding) {
        const sweeps = toolpathMovesToLinearSweeps(operation.toolpathMoves!, created.cell / 4);
        await args.client.stockRemoveSweep(created.stock, operationCutter, sweeps);
      }
      args.onProgress?.(0.45);
    } else {
      await args.client.stockRemoveSweep(created.stock, referenceCutter, previousToolSweeps!);
    }
    const referenceStockMesh = await args.client.stockToMesh(created.stock);
    if (referenceStockMesh.triangleCount === 0) {
      throw new Error('Reference-tool stock volume produced no display mesh.');
    }
    args.onProgress?.(0.45);
    ir = await args.client.generateRestFinish({
      partMesh: args.partMesh,
      cutter,
      referenceToolDiameter: referenceCutter.diameter,
      referenceCornerRadius: referenceCutter.kind === 'ball' ? referenceCutter.diameter / 2 : 0,
      tolerance: args.params.tolerance,
      stockToLeave: args.params.stockToLeave,
      stepdown: args.params.stepdown,
      direction: args.params.direction,
      spindleRotation,
      stock: created.stock,
      stockBounds: args.stockBounds,
      cellSize,
      heights: {
        clearanceZ: args.resolvedHeights.clearanceZ,
        retractZ: args.resolvedHeights.retractZ,
        feedZ: args.resolvedHeights.feedZ,
        materialTopZ: args.resolvedHeights.stockTopZ,
      },
      topZ: args.stockBounds.maxZ,
      bottomZ: args.resolvedHeights.bottomZ,
      ...(args.boundary !== undefined ? { boundary: args.boundary } : {}),
      stockSource: args.params.stockSource,
    }, {
      signal: args.signal,
      onProgress: fraction => args.onProgress?.(0.45 + fraction * 0.55),
    });
  } finally {
    await args.client.stockDispose(created.stock);
  }
  const computeTimeMs = performance.now() - started;
  const feeds = Object.prototype.hasOwnProperty.call(args, 'feedrateOverride')
    ? resolveFeedrates(args.tool, args.feedrateOverride) : undefined;
  const moves = irToToolpathMoves(ir, feeds);
  if (moves.length === 0) throw new Error('Rest machining produced no toolpath moves. The reference tool may already reach the whole region.');
  return { moves, computeTimeMs };
}
