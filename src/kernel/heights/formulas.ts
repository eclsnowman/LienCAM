// WO-3020 (alpha.3 A3-11, parity): the ONE depth-formula module. Today each
// formula family computes its band inside its own evidence builder
// (src/lib/cam/smartHeights/chamfer.ts:425, threadMill.ts:542-552,
// engrave.ts:171-202 + :433-437, vcarve.ts:156-188 + :344-346 - not edited).
// The arithmetic and the operator text are copied here exactly; the parity test
// compares every function to today's on the same inputs.
//
// `override_moves_formula` (MD-57) is a CARD and stays off: an operator Top /
// Bottom override changes the plan (resolve.ts operatorEnd), never these depths.

import type { Tool, ToolType } from '../../types'
import type {
  ChamferEdgeFormulaIntent,
  EngravePathFormulaIntent,
  ThreadBandFormulaIntent,
  VCarveRegionFormulaIntent,
} from './contracts'

/** A formula band in machine Z: where the cut starts and where the cutter center ends. */
export interface FormulaBand {
  materialStartMachineMm: number
  cutterEndMachineMm: number
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`)
  return value
}

function positive(value: number, label: string): number {
  const checked = finite(value, label)
  if (checked <= 0) throw new Error(`${label} must be greater than zero.`)
  return checked
}

function nonNegative(value: number, label: string): number {
  const checked = finite(value, label)
  if (checked < 0) throw new Error(`${label} cannot be negative.`)
  return checked
}

/** Material an earlier operation already removed lowers the datum, never raises it
 *  (chamfer.ts:362, engrave.ts / vcarve.ts remaining-material blocks). */
export function effectiveDatumMachineMm(datumMachineMm: number, remainingTopMachineMm?: number): number {
  return remainingTopMachineMm !== undefined && remainingTopMachineMm < datumMachineMm
    ? remainingTopMachineMm
    : datumMachineMm
}

/** Chamfer: start at the (effective) edge datum, end the chamfer width plus the tip offset below it. */
export function chamferBand(input: {
  formula: Pick<ChamferEdgeFormulaIntent, 'chamferWidthMm' | 'tipOffsetMm'>
  datumMachineMm: number
  remainingTopMachineMm?: number
}): FormulaBand {
  const datum = effectiveDatumMachineMm(input.datumMachineMm, input.remainingTopMachineMm)
  return {
    materialStartMachineMm: datum,
    cutterEndMachineMm: datum - input.formula.chamferWidthMm - input.formula.tipOffsetMm,
  }
}

/** Thread mill: a downward thread runs its length below the (effective) datum; an
 *  upward (external base) thread starts its length above the datum, capped by the
 *  remaining material, and ends at the datum. The remaining top lowers only a
 *  downward datum (threadMill.ts:542-552). */
export function threadBand(input: {
  formula: Pick<ThreadBandFormulaIntent, 'direction' | 'depthMm'>
  datumMachineMm: number
  remainingTopMachineMm?: number
}): FormulaBand {
  const { direction, depthMm } = input.formula
  const datum = input.datumMachineMm
  const remainingTop = input.remainingTopMachineMm
  const effective = direction === 'down' ? effectiveDatumMachineMm(datum, remainingTop) : datum
  return {
    materialStartMachineMm: direction === 'up'
      ? (remainingTop !== undefined ? Math.min(datum + depthMm, remainingTop) : datum + depthMm)
      : effective,
    cutterEndMachineMm: direction === 'down' ? effective - depthMm : datum,
  }
}

/** Engrave: the explicit depth, or the depth that opens the requested line width
 *  with this V-tool (engrave.ts:171-202, same checks, same words). */
export function engraveDepthMm(formula: Pick<EngravePathFormulaIntent, 'depth'>, tool: Tool): number {
  const diameter = positive(tool.diameter, 'Engrave tool diameter')
  const fluteLength = positive(tool.fluteLength, 'Engrave tool flute length')
  if (formula.depth.kind === 'explicit') {
    const depth = positive(formula.depth.depthMm, 'Engrave depth')
    if (depth > fluteLength + 1e-9) {
      throw new Error(`Engrave depth ${depth} mm exceeds the tool flute length ${fluteLength} mm.`)
    }
    return depth
  }

  const angle = finite(tool.angleFromAxisDeg ?? NaN, 'Engrave tool half-angle')
  if (angle <= 0 || angle >= 90) {
    throw new Error('Engrave tool half-angle must be greater than zero and less than 90 degrees.')
  }
  const tipDiameter = finite(tool.tipDiameter ?? 0, 'Engrave tool tip diameter')
  if (tipDiameter < 0 || tipDiameter >= diameter) {
    throw new Error('Engrave tool tip diameter must be non-negative and smaller than its diameter.')
  }
  const tanHalf = Math.tan(angle * Math.PI / 180)
  const maximumWidth = Math.min(diameter, tipDiameter + 2 * fluteLength * tanHalf)
  const width = positive(formula.depth.targetLineWidthMm, 'Engrave line width')
  if (width <= tipDiameter + 1e-9) {
    throw new Error(`Engrave line width must be greater than the tool tip-flat diameter ${tipDiameter} mm.`)
  }
  if (width > maximumWidth + 1e-9) {
    throw new Error(
      `Engrave line width ${width} mm exceeds the tool's usable profile width ${Number(maximumWidth.toFixed(6))} mm.`,
    )
  }
  return (width - tipDiameter) / (2 * tanHalf)
}

/** Engrave band: Material Start is the effective datum shifted by the axial offset; a
 *  surface-following engrave ends below the lowest sampled surface instead (engrave.ts:433-437). */
export function engraveBand(input: {
  formula: Pick<EngravePathFormulaIntent, 'axialOffsetMm'>
  depthMm: number
  datumMachineMm: number
  remainingTopMachineMm?: number
  surfaceMinMachineMm?: number
}): FormulaBand {
  const materialStart = effectiveDatumMachineMm(input.datumMachineMm, input.remainingTopMachineMm) +
    input.formula.axialOffsetMm
  return {
    materialStartMachineMm: materialStart,
    cutterEndMachineMm: input.surfaceMinMachineMm !== undefined
      ? input.surfaceMinMachineMm + input.formula.axialOffsetMm - input.depthMm
      : materialStart - input.depthMm,
  }
}

/** Tool types whose record carries a tip angle: today's TOOL_TYPE_META hasAngle
 *  (src/lib/tool/toolMeta.ts:47-67). The parity test pins this set to that table. */
export const ANGLED_TOOL_TYPES: ReadonlySet<ToolType> = new Set<ToolType>([
  'chamfer_mill', 'tapered_endmill', 'dovetail_mill', 'v_bit',
  'drill', 'spot_drill', 'center_drill', 'countersink',
])

/** V-carve: the bit's own deepest cut - full diameter reached, or flute length (vcarve.ts:156-168). */
export function vcarveToolLimitDepthMm(tool: Tool): number {
  const angle = tool.angleFromAxisDeg
  if (typeof angle !== 'number' || !Number.isFinite(angle) || angle <= 0 || angle >= 90) {
    throw new Error(`V-carve tool "${tool.name}" needs a tip angle between 0 and 90 degrees per side (a V-bit, engraving bit or chamfer mill).`)
  }
  const diameter = positive(tool.diameter, 'V-carve tool diameter')
  const tipDiameter = nonNegative(tool.tipDiameter ?? 0, 'V-carve tool tip diameter')
  if (tipDiameter >= diameter) throw new Error('V-carve tool tip diameter must be smaller than its diameter.')
  const tanHalf = Math.tan(angle * Math.PI / 180)
  const byDiameter = (diameter - tipDiameter) / (2 * tanHalf)
  const flute = Number.isFinite(tool.fluteLength) && tool.fluteLength > 0 ? tool.fluteLength : Infinity
  return Math.min(byDiameter, flute)
}

/** V-carve: the deepest the tip may go below Material Start (vcarve.ts:170-188). */
export function vcarveMaxDepthMm(formula: Pick<VCarveRegionFormulaIntent, 'flatDepth'>, tool: Tool): number {
  if (formula.flatDepth.kind === 'tool_limit') return vcarveToolLimitDepthMm(tool)
  const depth = positive(formula.flatDepth.depthMm, 'V-carve flat depth')
  const limit = ANGLED_TOOL_TYPES.has(tool.type)
    ? vcarveToolLimitDepthMm(tool)
    : (Number.isFinite(tool.fluteLength) && tool.fluteLength > 0 ? tool.fluteLength : Infinity)
  if (depth > limit + 1e-9) {
    throw new Error(
      `V-carve flat depth ${depth} mm is deeper than tool "${tool.name}" can cut (${Number(limit.toFixed(3))} mm at its full diameter or flute length).`,
    )
  }
  return depth
}

/** V-carve band: carving starts startDepth below the effective datum and ends maxDepth below that (vcarve.ts:344-346). */
export function vcarveBand(input: {
  formula: Pick<VCarveRegionFormulaIntent, 'startDepthMm'>
  maxDepthMm: number
  datumMachineMm: number
  remainingTopMachineMm?: number
}): FormulaBand {
  const materialStart = effectiveDatumMachineMm(input.datumMachineMm, input.remainingTopMachineMm) -
    input.formula.startDepthMm
  return { materialStartMachineMm: materialStart, cutterEndMachineMm: materialStart - input.maxDepthMm }
}
