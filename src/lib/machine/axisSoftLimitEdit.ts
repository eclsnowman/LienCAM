// WO-1705 (Operator, binding: "one location for data, two lenses").
//
// THE ONE WRITE PATH FOR AN AXIS'S SOFT LIMITS ONCE A DEFINITION EXISTS.
// Travel IS the axis soft limits (ADR-0049, `machineTravel`). Two DIFFERENT
// operations write them, and each caller names the one it means - intent is
// never inferred from the numbers:
//
//   - `withAxisSoftLimitEdited` - ONE END set, exactly as typed (the Machine
//     area's "travel from" / "travel to" columns, the setup walkthrough's
//     Step 2). Pulling a soft limit a little inside the switch is routine
//     (Operator's Z: home 128.9 inside 129.1), so this NEVER touches homing.
//
//   - `withAxisTravelEdited` - the TRAVEL (span) changed, both ends set at
//     once (the Machine Library modal's Travel field). The home switch is AT
//     the home end of travel, so a stated homing value that sat there moves
//     to the new home end in the same edit.
//
// THE DEFECT THE SECOND CLOSES (WO-1705 opus review). Operator's X homes at max
// with zero at min - soft limits 0..738, homing value 738. Typing travel 700
// used to rewrite the soft limits to 0..700 but leave the homing value 738,
// which `machineHomeConvention` then read as an absolute home: G28 X went to
// 738, 38 mm past the controller's soft limit, and the CAM envelope became
// 38..738 while the controller said 0..700.
//
// A homing value NOT at the home end (a typed absolute coordinate) is never
// moved by either operation, even when the new travel leaves it outside the
// new limits; the existing envelope checks speak to that.

import {
  axisHomingIsStated,
  controllerZeroIsHomeSwitch,
  definitionStatesAxisSoftLimits,
  definitionStatesKey,
  machineTravel,
  type AxisName,
  type ControllerDefinition,
  type MachineConfig,
} from '../../types'
import { axisSoftLimitStatementKey } from './resolvedMachineMotion'

type EditableMachine = Pick<MachineConfig, 'controller' | 'controllerDefinition' | 'travel' | 'homeConvention'>

/** "At the end" tolerance: an imported 738.0004 is still at the 738 end. */
const AT_END_MM = 1e-3
const near = (a: number, b: number) => Math.abs(a - b) < AT_END_MM

/** The stated soft-limit pair, or null when either end is still a placeholder
 *  (or the span is not a travel). */
function statedSoftLimits(machine: EditableMachine, axis: AxisName): { min: number; max: number } | null {
  const configured = machine.controllerDefinition?.axes.find((a) => a.axis === axis)
  if (!configured || !definitionStatesAxisSoftLimits(machine, axis)) return null
  const { softLimitMin: min, softLimitMax: max } = configured
  return Number.isFinite(min) && Number.isFinite(max) && max - min > 0 ? { min, max } : null
}

/** Where the home end of this axis's travel is BEFORE a travel edit, when the
 *  stated homing value sits there - else null (no stated homing, or a homing
 *  value that is an absolute coordinate somewhere else).
 *
 *  With stated soft limits the home end is the soft limit on the side the
 *  axis homes toward. Without them (travel still read from the standalone
 *  field) the homing value is at an end when it is 0 (zero at the home end)
 *  or the far end's signed travel (zero at the other end). */
function homingValueAtHomeEnd(machine: EditableMachine, axis: AxisName): number | null {
  const homing = machine.controllerDefinition?.homing?.perAxis?.[axis]
  if (!homing || !Number.isFinite(homing.homingValue)) return null
  if (!axisHomingIsStated(machine, axis, 'direction') || !axisHomingIsStated(machine, axis, 'homingValue')) return null
  const side: 'min' | 'max' = homing.direction === 'positive' ? 'max' : 'min'
  const limits = statedSoftLimits(machine, axis)
  if (limits) return near(homing.homingValue, limits[side]) ? limits[side] : null
  if (axis !== 'X' && axis !== 'Y' && axis !== 'Z') return null
  if (near(homing.homingValue, 0)) return 0
  const travel = machineTravel(machine)[axis.toLowerCase() as 'x' | 'y' | 'z']
  const farEnd = side === 'max' ? travel : -travel
  return Number.isFinite(travel) && travel > 0 && near(homing.homingValue, farEnd) ? farEnd : null
}

/** The definition with the given soft-limit end(s) written and stated.
 *  Homing is untouched. */
function writeSoftLimits(
  machine: EditableMachine,
  definition: ControllerDefinition,
  axis: AxisName,
  limits: { min?: number; max?: number },
): ControllerDefinition {
  const ends = (['min', 'max'] as const).filter((end) => limits[end] !== undefined)
  let stated = definition.stated ?? []
  for (const end of ends) {
    const key = axisSoftLimitStatementKey(axis, end)
    if (!definitionStatesKey({ settings: definition.settings, stated }, machine.controller, key)) {
      stated = [...stated, { controller: machine.controller, key }]
    }
  }
  return {
    ...definition,
    stated,
    axes: definition.axes.map((a) => a.axis === axis
      ? {
          ...a,
          ...(limits.min !== undefined ? { softLimitMin: limits.min } : {}),
          ...(limits.max !== undefined ? { softLimitMax: limits.max } : {}),
        }
      : a),
  }
}

/**
 * ONE soft-limit end, set exactly as typed and stated. The homing value is
 * left exactly as it is - a soft limit pulled inside the switch is not a move
 * of the switch. Returns the machine's definition unchanged when it has none.
 */
export function withAxisSoftLimitEdited(
  machine: EditableMachine,
  axis: AxisName,
  end: 'min' | 'max',
  value: number,
): ControllerDefinition | undefined {
  const definition = machine.controllerDefinition
  if (!definition) return definition
  return writeSoftLimits(machine, definition, axis, { [end]: value })
}

/**
 * The axis's TRAVEL changed: both soft-limit ends set at once and stated.
 * When the axis's stated homing value sat at the home end of the OLD travel
 * (within 1e-3 mm), it moves to the new home end in the same edit. Returns
 * the machine's definition unchanged when it has none.
 */
export function withAxisTravelEdited(
  machine: EditableMachine,
  axis: AxisName,
  min: number,
  max: number,
): ControllerDefinition | undefined {
  const definition = machine.controllerDefinition
  if (!definition) return definition
  const oldHomeEnd = homingValueAtHomeEnd(machine, axis)
  const next = writeSoftLimits(machine, definition, axis, { min, max })
  if (controllerZeroIsHomeSwitch(machine.controller)) {
    const homing = next.homing.perAxis[axis]
    if (!homing || homing.homingValue === 0) return next
    // WO-1755: changing travel in either lens cannot move GRBL's machine zero
    // away from the switch. Old records carrying the former value are healed.
    return {
      ...next,
      homing: {
        ...next.homing,
        perAxis: { ...next.homing.perAxis, [axis]: { ...homing, homingValue: 0 } },
      },
    }
  }
  if (oldHomeEnd === null) return next
  const newLimits = statedSoftLimits({ ...machine, controllerDefinition: next }, axis)
  if (!newLimits) return next
  const homing = next.homing.perAxis[axis]!
  const newHomeEnd = homing.direction === 'positive' ? newLimits.max : newLimits.min
  // The home end did not move: the homing value stays exactly as typed.
  if (near(newHomeEnd, oldHomeEnd)) return next
  return {
    ...next,
    homing: {
      ...next.homing,
      perAxis: { ...next.homing.perAxis, [axis]: { ...homing, homingValue: newHomeEnd } },
    },
  }
}
