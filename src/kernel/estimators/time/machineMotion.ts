// WO-3034 (alpha.3 A3-21): re-hosted copy of src/lib/simulation/machineCutTimeMotion.ts for the kernel estimators
// (draft WO-A3-21: today's time model is re-hosted as copies; the current engine's
// file is not touched). Kept verbatim below this header so post-plan time equals
// the store's estimatedCutTimeMs; estimators.wo3034.test.ts pins that parity.
// WO-2024: the machine facts the cut-time estimate needs, read from the
// machine's own controller definition. The same reads the feed-estimate panel
// makes (ToolpathFeedEstimatePanel: machineAxisAccelerations /
// machineStopAtAngleDeg), in lib/ so the store and the simulator can reach
// them without importing a component.
//
// Absence stays absent: a machine with no definition, or one missing an XYZ
// acceleration, yields null and the estimate stays distance / feed.

import { controllerSettingNumber, type AxisDefinition, type MachineConfig } from '../../../types'
import type { CutTimeMotion } from './runtime'

function positiveAxisValue(
  axes: readonly AxisDefinition[] | undefined,
  axis: AxisDefinition['axis'],
  field: 'acceleration' | 'maxVelocity',
): number | undefined {
  const value = axes?.find((candidate) => candidate.axis === axis)?.[field]
  return Number.isFinite(value) && (value as number) > 0 ? value : undefined
}

export function machineCutTimeMotion(
  machine: Pick<MachineConfig, 'controller' | 'controllerDefinition'>,
): CutTimeMotion | null {
  const axes = machine.controllerDefinition?.axes
  const x = positiveAxisValue(axes, 'X', 'acceleration')
  const y = positiveAxisValue(axes, 'Y', 'acceleration')
  const z = positiveAxisValue(axes, 'Z', 'acceleration')
  if (x === undefined || y === undefined || z === undefined) return null
  const setting = (key: string) => controllerSettingNumber(
    machine.controllerDefinition?.settings,
    machine.controller,
    key,
  )
  const stop = setting('Generalsettings.Stopatangle')
  const stopAtAngleDeg = stop !== null && stop >= 0 && stop <= 180 ? stop : undefined
  const maxVelocityMmMin = {
    x: positiveAxisValue(axes, 'X', 'maxVelocity'),
    y: positiveAxisValue(axes, 'Y', 'maxVelocity'),
    z: positiveAxisValue(axes, 'Z', 'maxVelocity'),
  }
  // WO-2148: UCCNC joins short G1 moves before planning them - only when the
  // profile states all three limits.
  const linearErrorMm = setting('Generalsettings.Linearerror')
  const maxAddMm = setting('Generalsettings.MaxLinearaddlenght')
  const maxUnifiedMm = setting('Generalsettings.MaxLinearunificationlenght')
  const linearUnification = [linearErrorMm, maxAddMm, maxUnifiedMm].every((v) => v !== null && v > 0)
    ? { linearErrorMm: linearErrorMm as number, maxAddMm: maxAddMm as number, maxUnifiedMm: maxUnifiedMm as number }
    : undefined
  const facts = [`acceleration X ${x} / Y ${y} / Z ${z} mm/s^2`]
  if (maxVelocityMmMin.x || maxVelocityMmMin.y || maxVelocityMmMin.z) {
    facts.push(`max velocity X ${maxVelocityMmMin.x ?? '-'} / Y ${maxVelocityMmMin.y ?? '-'} / Z ${maxVelocityMmMin.z ?? '-'} mm/min`)
  }
  if (stopAtAngleDeg !== undefined) facts.push(`full stop at corners over ${stopAtAngleDeg} deg`)
  if (linearUnification) {
    facts.push(`short moves joined: up to ${linearUnification.maxAddMm} mm each, lines up to ${linearUnification.maxUnifiedMm} mm within ${linearUnification.linearErrorMm} mm`)
  }
  return {
    axisAccelerations: { x, y, z },
    maxVelocityMmMin,
    stopAtAngleDeg,
    ...(linearUnification ? { linearUnification } : {}),
    facts,
  }
}
