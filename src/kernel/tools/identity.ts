import type { ToolDefinition } from './model'

export type ToolLengthUnit = 'mm' | 'inches'

/** Exact decimal normalization, including exponents, with rational 25.4 mm/in.
 * No size buckets or tolerance rounding: 6.00001 and 6 remain distinct keys.
 * A computed noisy number keeps its noise; callers may compare candidates but
 * must never use approximate equality to merge ids or broaden confirmation. */
function decimal(value: number | undefined, unit: ToolLengthUnit = 'mm'): string | null {
  if (value === undefined) return null
  if (!Number.isFinite(value)) throw new RangeError('Physical identity needs finite stated dimensions')
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e')
  const [whole, fraction = ''] = mantissa.split('.')
  let coefficient = BigInt(whole + fraction) * (unit === 'inches' ? 254n : 1n)
  let scale = fraction.length - Number(exponent) + (unit === 'inches' ? 1 : 0)
  if (coefficient === 0n) return '0'
  while (coefficient % 10n === 0n) { coefficient /= 10n; scale-- }
  return `${coefficient}e${-scale}`
}

/** Comparison key, not an id. Geometry/material/hand determine a physical cutter;
 * labels, tool numbers, libraries, feeds, holder and installed stickout do not.
 * Missing geometry is distinct from stated zero, including defaultable angles.
 * Both fallback id and original unknown type participate; no unknown promotion. */
export function physicalToolKey(tool: ToolDefinition, unit: ToolLengthUnit = 'mm'): string {
  const lengths = [tool.diameter, tool.fluteLength, tool.shankDiameter, tool.overallLength,
    tool.shoulderLength, tool.cornerRadius, tool.tipDiameter, tool.neckDiameter, tool.threadPitch]
  const scalars = [tool.numberOfFlutes, tool.angleFromAxisDeg, tool.threadFormAngleDeg,
    tool.threadTeethCount, tool.neckTransitionAngleDeg]
  return JSON.stringify(['kernel.toolPhysical.v1', tool.type, tool.declaredTypeRaw ?? null,
    ...lengths.map(value => decimal(value, unit)), ...scalars.map(value => decimal(value)),
    tool.material, tool.coating, tool.cutHand ?? 'right'])
}
