import type { OperationType } from '../types'
import { parameterDefaults, DEFAULT_ADAPTIVE3D_PARAMS, DEFAULT_PARALLEL3D_PARAMS, DEFAULT_WATERLINE_PARAMS, DEFAULT_STEEP_SHALLOW3D_PARAMS, DEFAULT_SCALLOP3D_PARAMS, DEFAULT_PENCIL3D_PARAMS, DEFAULT_REST3D_PARAMS, DEFAULT_REST_MACHINING_SETTINGS } from './parameterDefaults'
import type { Adaptive3dParams, Parallel3dParams, WaterlineParams, SteepShallow3dParams, Scallop3dParams, Pencil3dParams, Rest3dParams, RestMachiningSettings } from './parameterTypes'

export interface ParameterField {
  default: unknown
  unit: 'mm' | 'degrees' | 'percent' | 'fraction' | 'count' | 'seconds' | 'none'
  min?: number
  max?: number
  exclusiveMin?: boolean
  exclusiveMax?: boolean
  /** Existing authoring/reader policy. Current 3D readers consume these same limits. */
  outsideRange?: 'clamp' | 'default'
}
const mm: ParameterField['unit'] = 'mm'
const rules: Record<string, Partial<ParameterField>> = {
  tolerance: { unit: mm, min: 0, exclusiveMin: true, outsideRange: 'default' },
  stepover: { unit: mm, min: 0, exclusiveMin: true, outsideRange: 'default' },
  stepdown: { unit: mm, min: 0, exclusiveMin: true, outsideRange: 'default' },
  maxStepdown: { unit: mm, min: 0, exclusiveMin: true, outsideRange: 'default' },
  angleDeg: { unit: 'degrees' },
  thresholdDeg: { unit: 'degrees', min: 0, max: 90, outsideRange: 'clamp' },
  minSlopeDeg: { unit: 'degrees', min: 0, max: 90, exclusiveMax: true, outsideRange: 'default' },
  maxSlopeDeg: { unit: 'degrees', min: 0, max: 90, exclusiveMin: true, outsideRange: 'default' },
  stockToLeave: { unit: mm, min: 0, outsideRange: 'default' },
  surfaceStockToLeave: { unit: mm, min: 0, outsideRange: 'default' },
  finishDepth: { unit: mm, min: 0, exclusiveMin: true, outsideRange: 'default' },
  stockEdgeOvershoot: { unit: mm, min: 0, outsideRange: 'default' },
  scallopHeight: { unit: mm, min: 0, exclusiveMin: true, outsideRange: 'default' },
  loopbackFilletPct: { unit: 'percent', min: 5, max: 100, outsideRange: 'default' },
  helixAngleDeg: { unit: 'degrees', min: 0.5, max: 30, outsideRange: 'default' },
  wallLeadInRadius: { unit: mm, min: 0, outsideRange: 'default' },
  wallLeadOutRadius: { unit: mm, min: 0, outsideRange: 'default' },
  integralWallFollowLengthFactor: { unit: 'none', min: 0, exclusiveMin: true, outsideRange: 'default' },
  radialStockToLeave: { unit: mm, min: 0, outsideRange: 'default' },
  axialStockToLeave: { unit: mm, min: 0, outsideRange: 'default' },
  cellSize: { unit: mm, min: 0, outsideRange: 'default' },
  referenceToolDiameter: { unit: mm, min: 0, exclusiveMin: true, outsideRange: 'default' },
  referenceCornerRadius: { unit: mm, min: 0, outsideRange: 'default' },
  rampAngle: { unit: 'degrees' },
  dwell: { unit: 'seconds', min: 0 },
  springPasses: { unit: 'count', min: 0 },
}
const lengths = new Set(['planeOffset', 'tabWidth', 'tabHeight', 'stockOffset', 'passExtension',
  'leadInRadius', 'leadOutRadius', 'maxStayDownDistance', 'sideOffset', 'axialOffset',
  'targetLineWidth', 'startDepthMm', 'allowanceMm', 'flatDepthMm', 'peckDepth',
  'chipBreakRetract', 'breakthroughMm', 'majorDiameter', 'pitch', 'radialStepover',
  'threadDepth', 'chamferWidth', 'tipOffset', 'overlapMm', 'stayDownLift',
  'wallLeadInRadius', 'wallLeadOutRadius', 'radialStockToLeave', 'axialStockToLeave', 'cellSize'])

// Same spelling can carry different dimensions or historical reader policy.
function parameterPolicy(type: OperationType | 'rest_3d', name: string): Omit<ParameterField, 'default'> {
  const policy = { unit: lengths.has(name) ? mm : 'none', ...rules[name] } as Omit<ParameterField, 'default'>
  if (type === 'adaptive_3d' && name === 'stepover') return { ...policy, unit: 'fraction', max: 1 }
  if (type === 'adaptive_3d' && name === 'helixDiameter') return { unit: mm, min: 0, exclusiveMin: true, outsideRange: 'default' }
  if ((type === 'pocket_2d' || type === 'adaptive_clearing_2d') && name === 'helixDiameter') return { unit: 'percent' }
  if (type === 'waterline_3d' && name === 'stockToLeave') return { ...policy, outsideRange: 'clamp' }
  return policy
}

/** Fresh, deep-cloned defaults; one headless caller cannot mutate another's seeds. */
export function parameterSchema(type: OperationType) {
  const defaults: Record<string, unknown> = Object.fromEntries(Object.entries(structuredClone(parameterDefaults[type])))
  const fields: Record<string, ParameterField> = Object.fromEntries(Object.entries(defaults).map(([name, value]) => [name, {
    default: structuredClone(value), ...parameterPolicy(type, name),
  }]))
  return { defaults, fields }
}

// Current readers and queryable metadata share these numeric policies. These
// preserve historical fallbacks/clamps; they add no operator gate.
type ReaderType = OperationType | 'rest_3d'
function numeric<T extends number | undefined>(type: ReaderType, name: string, value: unknown, fallback: T): number | T {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const field = parameterPolicy(type, name)
  if (field.outsideRange === 'clamp') {
    return Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, value))
  }
  if (field.min !== undefined && (field.exclusiveMin ? value <= field.min : value < field.min)) return fallback
  if (field.max !== undefined && (field.exclusiveMax ? value >= field.max : value > field.max)) return fallback
  return value
}

export function readParallel3dParams(params: Record<string, unknown>): Parallel3dParams {
  const d = DEFAULT_PARALLEL3D_PARAMS
  return {
    stepover: numeric('parallel_3d', 'stepover', params.stepover, d.stepover),
    angleDeg: numeric('parallel_3d', 'angleDeg', params.angleDeg, d.angleDeg),
    tolerance: numeric('parallel_3d', 'tolerance', params.tolerance, d.tolerance),
    surfaceStockToLeave: numeric('parallel_3d', 'surfaceStockToLeave', params.surfaceStockToLeave, d.surfaceStockToLeave),
    maxSlopeDeg: numeric('parallel_3d', 'maxSlopeDeg', params.maxSlopeDeg, d.maxSlopeDeg),
    finishDepth: numeric('parallel_3d', 'finishDepth', params.finishDepth, d.finishDepth),
    useStockBoundary: typeof params.useStockBoundary === 'boolean' ? params.useStockBoundary : d.useStockBoundary,
    // WO-1271: undefined = AUTO (tool radius); 0 explicitly disables overrun.
    stockEdgeOvershoot: numeric('parallel_3d', 'stockEdgeOvershoot', params.stockEdgeOvershoot, d.stockEdgeOvershoot),
  }
}

export function readWaterlineParams(params: Record<string, unknown>): WaterlineParams {
  const d = DEFAULT_WATERLINE_PARAMS
  return {
    stepdown: numeric('waterline_3d', 'stepdown', params.stepdown, d.stepdown),
    tolerance: numeric('waterline_3d', 'tolerance', params.tolerance, d.tolerance),
    // Waterline historically clamps negative stock to zero; other readers default it.
    stockToLeave: numeric('waterline_3d', 'stockToLeave', params.stockToLeave, d.stockToLeave),
    minSlopeDeg: numeric('waterline_3d', 'minSlopeDeg', params.minSlopeDeg, d.minSlopeDeg),
    flatAreaDetection: typeof params.flatAreaDetection === 'boolean' ? params.flatAreaDetection : d.flatAreaDetection,
    order: params.order === 'level' ? 'level' : d.order,
    direction: params.direction === 'conventional' ? 'conventional' : d.direction,
    finishDepth: numeric('waterline_3d', 'finishDepth', params.finishDepth, d.finishDepth),
    useStockBoundary: typeof params.useStockBoundary === 'boolean' ? params.useStockBoundary : d.useStockBoundary,
    stockEdgeOvershoot: numeric('waterline_3d', 'stockEdgeOvershoot', params.stockEdgeOvershoot, d.stockEdgeOvershoot),
  }
}

/** Fresh waterline stepdown: 10% of tool diameter, never under 0.2 mm. */
export function defaultWaterlineStepdownFor(toolDiameter: number): number {
  if (!(toolDiameter > 0) || !Number.isFinite(toolDiameter)) return DEFAULT_WATERLINE_PARAMS.stepdown
  return Math.max(0.2, Math.round(toolDiameter * 0.1 * 100) / 100)
}

export function readSteepShallow3dParams(params: Record<string, unknown>): SteepShallow3dParams {
  const d = DEFAULT_STEEP_SHALLOW3D_PARAMS
  const threshold = numeric('steep_shallow_3d', 'thresholdDeg', params.thresholdDeg, d.thresholdDeg)
  // WO-1515 / BUG-422: preserve the clamp AND the exact disclosure rather
  // than silently replacing a finite out-of-range strategy split with 30.
  if (typeof params.thresholdDeg === 'number' && Number.isFinite(params.thresholdDeg) && threshold !== params.thresholdDeg) {
    console.warn(`steep_shallow_3d: thresholdDeg ${params.thresholdDeg} is out of range [0, 90]; using ${threshold}.`)
  }
  return {
    thresholdDeg: threshold,
    stepdown: numeric('steep_shallow_3d', 'stepdown', params.stepdown, d.stepdown),
    stepover: numeric('steep_shallow_3d', 'stepover', params.stepover, d.stepover),
    angleDeg: numeric('steep_shallow_3d', 'angleDeg', params.angleDeg, d.angleDeg),
    tolerance: numeric('steep_shallow_3d', 'tolerance', params.tolerance, d.tolerance),
    stockToLeave: numeric('steep_shallow_3d', 'stockToLeave', params.stockToLeave, d.stockToLeave),
    useStockBoundary: typeof params.useStockBoundary === 'boolean' ? params.useStockBoundary : d.useStockBoundary,
    finishDepth: numeric('steep_shallow_3d', 'finishDepth', params.finishDepth, d.finishDepth),
  }
}

export function readScallop3dParams(params: Record<string, unknown>): Scallop3dParams {
  const d = DEFAULT_SCALLOP3D_PARAMS
  return {
    scallopHeight: numeric('scallop_3d', 'scallopHeight', params.scallopHeight, d.scallopHeight),
    tolerance: numeric('scallop_3d', 'tolerance', params.tolerance, d.tolerance),
    stockToLeave: numeric('scallop_3d', 'stockToLeave', params.stockToLeave, d.stockToLeave),
    useStockBoundary: typeof params.useStockBoundary === 'boolean' ? params.useStockBoundary : d.useStockBoundary,
    finishDepth: numeric('scallop_3d', 'finishDepth', params.finishDepth, d.finishDepth),
    direction: params.direction === 'conventional' ? 'conventional' : d.direction,
    // WO-1282: same optional nonnegative AUTO policy as parallel/waterline.
    stockEdgeOvershoot: numeric('scallop_3d', 'stockEdgeOvershoot', params.stockEdgeOvershoot, d.stockEdgeOvershoot),
  }
}

export function readPencil3dParams(params: Record<string, unknown>): Pencil3dParams {
  const d = DEFAULT_PENCIL3D_PARAMS
  return {
    tolerance: numeric('pencil_3d', 'tolerance', params.tolerance, d.tolerance),
    stockToLeave: numeric('pencil_3d', 'stockToLeave', params.stockToLeave, d.stockToLeave),
    useStockBoundary: typeof params.useStockBoundary === 'boolean' ? params.useStockBoundary : d.useStockBoundary,
    finishDepth: numeric('pencil_3d', 'finishDepth', params.finishDepth, d.finishDepth),
    direction: params.direction === 'conventional' ? 'conventional' : d.direction,
  }
}

export function readAdaptive3dParams(params: Record<string, unknown>): Adaptive3dParams {
  const d = DEFAULT_ADAPTIVE3D_PARAMS
  return {
    maxStepdown: numeric('adaptive_3d', 'maxStepdown', params.maxStepdown, d.maxStepdown),
    // A fraction above 1 defaults; it has never clamped to 1 in this reader.
    stepover: numeric('adaptive_3d', 'stepover', params.stepover, d.stepover),
    millingDirection: params.millingDirection === 'conventional' ? 'conventional' : d.millingDirection,
    intermediateStepdown: typeof params.intermediateStepdown === 'boolean' ? params.intermediateStepdown : d.intermediateStepdown,
    wallLeadInRadius: numeric('adaptive_3d', 'wallLeadInRadius', params.wallLeadInRadius, d.wallLeadInRadius),
    wallLeadOutRadius: numeric('adaptive_3d', 'wallLeadOutRadius', params.wallLeadOutRadius, d.wallLeadOutRadius),
    loopbackFilletPct: numeric('adaptive_3d', 'loopbackFilletPct', params.loopbackFilletPct, d.loopbackFilletPct),
    integralWallFollow: typeof params.integralWallFollow === 'boolean' ? params.integralWallFollow : d.integralWallFollow,
    integralWallFollowLengthFactor: numeric('adaptive_3d', 'integralWallFollowLengthFactor', params.integralWallFollowLengthFactor, d.integralWallFollowLengthFactor),
    tolerance: numeric('adaptive_3d', 'tolerance', params.tolerance, d.tolerance),
    helixDiameter: numeric('adaptive_3d', 'helixDiameter', params.helixDiameter, d.helixDiameter),
    helixAngleDeg: numeric('adaptive_3d', 'helixAngleDeg', params.helixAngleDeg, d.helixAngleDeg),
    radialStockToLeave: numeric('adaptive_3d', 'radialStockToLeave', params.radialStockToLeave, d.radialStockToLeave),
    axialStockToLeave: numeric('adaptive_3d', 'axialStockToLeave', params.axialStockToLeave, d.axialStockToLeave),
    // 0 is AUTO; positive values override. No new grid clamp is applied.
    cellSize: numeric('adaptive_3d', 'cellSize', params.cellSize, d.cellSize),
    useStockBoundary: typeof params.useStockBoundary === 'boolean' ? params.useStockBoundary : d.useStockBoundary,
    stockEdgeOvershoot: numeric('adaptive_3d', 'stockEdgeOvershoot', params.stockEdgeOvershoot, d.stockEdgeOvershoot),
  }
}

export function readRestMachiningSettings(params: Record<string, unknown>): RestMachiningSettings {
  return {
    restMachining: params.restMachining === true,
    stockSource: params.stockSource === 'previous_tool' ? 'previous_tool' : DEFAULT_REST_MACHINING_SETTINGS.stockSource,
  }
}

export function readRest3dParams(params: Record<string, unknown>): Rest3dParams {
  const d = DEFAULT_REST3D_PARAMS
  return {
    // Missing/unrecognized follows authoring defaults, not the previous_tool
    // compatibility seed. This distinction is intentional (WO-1513).
    stockSource: readRestMachiningSettings(params).stockSource,
    referenceToolDiameter: numeric('rest_3d', 'referenceToolDiameter', params.referenceToolDiameter, d.referenceToolDiameter),
    referenceCornerRadius: numeric('rest_3d', 'referenceCornerRadius', params.referenceCornerRadius, d.referenceCornerRadius),
    tolerance: numeric('rest_3d', 'tolerance', params.tolerance, d.tolerance),
    stockToLeave: numeric('rest_3d', 'stockToLeave', params.stockToLeave,
      numeric('rest_3d', 'stockToLeave', params.surfaceStockToLeave, d.stockToLeave)),
    stepdown: numeric('rest_3d', 'stepdown', params.stepdown, d.stepdown),
    useStockBoundary: typeof params.useStockBoundary === 'boolean' ? params.useStockBoundary : d.useStockBoundary,
    direction: params.direction === 'conventional' ? 'conventional' : d.direction,
  }
}

// Explicit authored edits share this boundary; current numeric readers are unchanged.
export { editOperation, type OperationEdit } from './operationEdits'
