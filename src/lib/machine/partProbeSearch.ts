import { definitionStatesAxisSoftLimits, type MachineConfig } from '../../types'

export type PartProbeSearchBasis =
  | 'machine-limit'
  | 'operator-override'
  | 'configured-fallback'

export interface PartProbeSearchPlan {
  basis: PartProbeSearchBasis
  startMachineZ: number | null
  bottomMachineZ: number | null
  targetMachineZ: number | null
  travelMm: number
}

const COMMAND_DECIMALS = 4
const COMMAND_SCALE = 10 ** COMMAND_DECIMALS
const COMMAND_FLOOR_EPSILON_MM = 1e-9

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * The Z bottom explicitly stated by the machine definition, or null.
 *
 * WO-1798 audit: a bottom is stated only when the definition carries the
 * provenance for BOTH soft-limit ends - a person edited them or an imported
 * profile named them - which is the shared reader `machineTravel` and
 * `axisSoftLimitsAreStated` already use (`definitionStatesAxisSoftLimits`).
 * Raw numbers alone are not a statement: the 0 placeholders
 * `createDefaultAxisDefinition` puts on a blank axis, and a default min with
 * an edited max, would otherwise invent a Z0 boundary the machine never
 * declared. Explicitly STATED zero endpoints remain real limits, and the
 * numeric validity the motion resolver requires is retained on top: both
 * endpoints finite and max > min. Unusable or unstated spans resolve to null
 * so the probe keeps the existing configured distance.
 */
export function partProbeMachineBottom(
  machine: Pick<MachineConfig, 'controller' | 'controllerDefinition'> | null | undefined,
): number | null {
  if (!machine || !definitionStatesAxisSoftLimits(machine, 'Z')) return null
  const axis = machine.controllerDefinition?.axes.find((candidate) => candidate.axis === 'Z')
  if (!axis || !finite(axis.softLimitMin) || !finite(axis.softLimitMax)) return null
  return axis.softLimitMax > axis.softLimitMin ? axis.softLimitMin : null
}

/**
 * The downward part-probe search used by both preview and execution.
 *
 * An operator override is identified by key presence, never by comparing its
 * value with a default. Without that key, a usable machine Z and stated bottom
 * search the remaining travel. Unknown facts retain the existing finite
 * configured search. Distances aimed at the bottom are truncated to the four
 * decimals sent by the text backend so rounding cannot put its target below the
 * approved limit.
 */
export function planPartProbeSearch(
  machine: Pick<MachineConfig, 'controller' | 'controllerDefinition' | 'probeOverrides'> | null | undefined,
  currentMachineZ: number | null | undefined,
  configuredMaxTravelMm: number,
): PartProbeSearchPlan {
  const startMachineZ = finite(currentMachineZ) ? currentMachineZ : null
  const bottomMachineZ = partProbeMachineBottom(machine)
  const hasOperatorOverride = machine?.probeOverrides !== undefined
    && Object.prototype.hasOwnProperty.call(machine.probeOverrides, 'maxTravel')

  if (startMachineZ === null || bottomMachineZ === null) {
    return {
      basis: 'configured-fallback',
      startMachineZ,
      bottomMachineZ,
      targetMachineZ: startMachineZ === null || !finite(configuredMaxTravelMm)
        ? null
        : startMachineZ - configuredMaxTravelMm,
      travelMm: configuredMaxTravelMm,
    }
  }

  const remaining = startMachineZ - bottomMachineZ
  const boundedRemaining = remaining > 0
    ? Math.floor((remaining + COMMAND_FLOOR_EPSILON_MM) * COMMAND_SCALE) / COMMAND_SCALE
    : remaining
  const travelMm = hasOperatorOverride
    ? Math.min(boundedRemaining, configuredMaxTravelMm)
    : boundedRemaining
  return {
    basis: hasOperatorOverride ? 'operator-override' : 'machine-limit',
    startMachineZ,
    bottomMachineZ,
    targetMachineZ: travelMm > 0 ? Math.max(bottomMachineZ, startMachineZ - travelMm) : startMachineZ,
    travelMm,
  }
}

/** Clamp the second downward touch to the same stated machine bottom. */
export function partProbeFineSearchMm(
  retractedMachineZ: number,
  requestedMm: number,
  bottomMachineZ: number | null,
): number {
  if (bottomMachineZ === null) return requestedMm
  const remaining = retractedMachineZ - bottomMachineZ
  if (!(remaining > 0)) return remaining
  const bounded = Math.min(requestedMm, remaining)
  return Math.floor((bounded + COMMAND_FLOOR_EPSILON_MM) * COMMAND_SCALE) / COMMAND_SCALE
}

/** Round an absolute downward target without ever rounding it below the floor. */
export function partProbeTargetAtOrAboveBottom(
  targetMachineZ: number,
  bottomMachineZ: number | null,
): number {
  if (bottomMachineZ === null) return Number(targetMachineZ.toFixed(COMMAND_DECIMALS))
  if (targetMachineZ <= bottomMachineZ + COMMAND_FLOOR_EPSILON_MM) return bottomMachineZ
  return Math.max(
    bottomMachineZ,
    Math.ceil((targetMachineZ - Number.EPSILON) * COMMAND_SCALE) / COMMAND_SCALE,
  )
}
