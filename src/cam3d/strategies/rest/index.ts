import type { GeometryKernel, MeshHandle, CutterSpec } from '../../kernel/types';
import type { Ring } from '../../geom2d';
import type { Box3, ZDexelField } from '../../stock';
import type { PathBuildHeights } from '../../pathbuild';
import type { ToolpathIR } from '../../ir/types';
import { adaptiveRough } from '../adaptiveRough';

export interface RestFinishInput {
  mesh: MeshHandle;
  cutter: CutterSpec;
  referenceToolDiameter: number;
  referenceCornerRadius: number;
  tolerance: number;
  stockToLeave: number;
  stepdown: number;
  direction: 'climb' | 'conventional';
  spindleRotation: 'cw' | 'ccw';
  stockBounds: Box3;
  cellSize: number;
  heights: PathBuildHeights;
  topZ: number;
  bottomZ: number;
  boundary?: readonly Ring[];
  /** Exact reference-tool stock created and swept by the caller. */
  referenceStock?: ZDexelField;
}

export interface RestFinishResult {
  ir: ToolpathIR;
  referenceIr?: ToolpathIR;
  referenceStock: ZDexelField;
}

function fail(message: string): never {
  const error = new Error(`restFinish: ${message}`);
  error.name = 'RestFinishError';
  throw error;
}

function referenceCutter(input: RestFinishInput): CutterSpec {
  const diameter = input.referenceToolDiameter;
  const cornerRadius = input.referenceCornerRadius;
  if (!(diameter > 0) || !Number.isFinite(diameter)) fail('reference tool diameter must be greater than zero');
  if (!(cornerRadius >= 0) || !Number.isFinite(cornerRadius) || cornerRadius > diameter / 2) {
    fail('reference corner radius must be between zero and half the reference tool diameter');
  }
  if (!(diameter > input.cutter.diameter)) {
    fail('Reference tool diameter must be greater than this operation\'s cutter diameter.');
  }
  if (cornerRadius === 0) return { kind: 'flat', diameter };
  if (Math.abs(cornerRadius - diameter / 2) <= 1e-9) return { kind: 'ball', diameter };
  fail('Intermediate bull-nose reference tools are not supported by the stock sweep yet; use a flat or ball reference tool.');
}

export async function restFinish(
  kernel: GeometryKernel,
  input: RestFinishInput,
  opts?: { signal?: AbortSignal; onProgress?: (fraction: number) => void },
): Promise<RestFinishResult> {
  if (input.cutter.kind !== 'flat' && input.cutter.kind !== 'ball') {
    fail('the rest cutter must be a flat or ball end mill');
  }
  if (!(input.tolerance > 0) || !Number.isFinite(input.tolerance)) fail('tolerance must be greater than zero');
  if (!(input.stockToLeave >= 0) || !Number.isFinite(input.stockToLeave)) fail('stockToLeave must be zero or greater');
  if (!(input.stepdown > 0) || !Number.isFinite(input.stepdown)) fail('stepdown must be greater than zero');
  const reference = referenceCutter(input);
  const common = {
    mesh: input.mesh,
    stockBounds: input.stockBounds,
    cellSize: input.cellSize,
    maxStepdown: input.stepdown,
    stepover: 0.4,
    millingDirection: input.direction,
    spindleRotation: input.spindleRotation,
    wallLeadInRadius: 0,
    wallLeadOutRadius: 0,
    loopbackFilletPct: 25,
    integralWallFollow: true,
    integralWallFollowLengthFactor: 2,
    tolerance: input.tolerance,
    helixDiameter: Math.max(input.tolerance, Math.min(input.cutter.diameter, reference.diameter) * 0.6),
    helixAngleDeg: 10,
    heights: {
      clearanceZ: input.heights.clearanceZ,
      retractZ: input.heights.retractZ,
      feedZ: input.heights.feedZ,
    },
    materialTopZ: input.topZ,
    floorZ: input.bottomZ,
    stockBoundsAreRealStock: true,
    ...(input.boundary !== undefined ? { boundary: input.boundary } : {}),
  };

  let referenceStock = input.referenceStock;
  let referenceIr: ToolpathIR | undefined;
  if (referenceStock === undefined) {
    referenceIr = await adaptiveRough(kernel, {
      ...common,
      cutter: reference,
    }, {
      signal: opts?.signal,
      onProgress: fraction => opts?.onProgress?.(fraction * 0.45),
      onCarvedStock: stock => { referenceStock = stock; },
    });
    if (referenceStock === undefined) fail('reference rough did not return its carved stock volume');
  }

  const ir = await adaptiveRough(kernel, {
    ...common,
    cutter: input.cutter,
    radialStockToLeave: input.stockToLeave,
    axialStockToLeave: input.stockToLeave,
    startFromStock: referenceStock,
  }, {
    signal: opts?.signal,
    onProgress: fraction => opts?.onProgress?.(0.45 + fraction * 0.55),
  });
  return {
    ir: {
      ...ir,
      meta: {
        ...ir.meta,
        strategyId: 'rest_finish_reference_tool',
        params: {
          ...ir.meta.params,
          referenceToolDiameter: input.referenceToolDiameter,
          referenceCornerRadius: input.referenceCornerRadius,
          cellSize: input.cellSize,
        },
      },
    },
    ...(referenceIr !== undefined ? { referenceIr } : {}),
    referenceStock,
  };
}
