import type { MachineConfig } from '../../types'

/** The spindle facts a fallback rpm is read against. A machine states a range
 * or states none; an unstated bound never invents a clamp. */
export type SpindleRangeMachine = Pick<MachineConfig, 'minSpindleRpm' | 'maxSpindleRpm'>

/**
 * Keep a suggested spindle speed inside the range stated by the machine
 * definition. Missing or invalid bounds leave that side of the suggestion
 * untouched; this helper never invents a range.
 */
export function rpmInMachineRange(
  rpm: number,
  machine: SpindleRangeMachine | undefined | null,
): number {
  if (!machine) return rpm
  const { minSpindleRpm: min, maxSpindleRpm: max } = machine
  const capped = typeof max === 'number' && Number.isFinite(max) && max > 0
    ? Math.min(rpm, max)
    : rpm
  return typeof min === 'number' && Number.isFinite(min) && min > 0
    ? Math.max(capped, min)
    : capped
}
