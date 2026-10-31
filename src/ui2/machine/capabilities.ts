// WO-3303: the software-side machine capabilities, moved here from Settings: what LienCAM itself
// enforces for a machine, read from the record. A pure read; the words come in, nothing is invented.
import { homeBackOffProvenance, type AxisName, type MachineConfig } from '../../types'
import { cloneGrblSettings } from '../../lib/machine/grbl/settings'
import { isGrblFamily } from '../../lib/machine/machineChoice'
import { axisSoftLimitsAreStated } from '../../lib/machine/resolvedMachineMotion'

const GRBL_AXIS_OFFSET: Partial<Record<AxisName, number>> = { X: 0, Y: 1, Z: 2 }

function grblStates(machine: MachineConfig, id: number): boolean {
  if (!isGrblFamily(machine.controller)) return false
  const raw = cloneGrblSettings(machine)[id]
  return raw !== undefined && Number.isFinite(Number(raw)) && raw.trim() !== ''
}

function softLimitsAreStated(machine: MachineConfig, axis: AxisName): boolean {
  if (axisSoftLimitsAreStated(machine, axis)) return true
  const offset = GRBL_AXIS_OFFSET[axis]
  return offset !== undefined && grblStates(machine, 130 + offset)
}

function backOffIsStated(machine: MachineConfig, axis: AxisName): boolean {
  if (homeBackOffProvenance(machine.controllerDefinition, axis, machine.controller) === 'machine') return true
  return GRBL_AXIS_OFFSET[axis] !== undefined && grblStates(machine, 27)
}

export interface CapabilityWords {
  readonly notConfigured: string
  readonly axisNotStated: (axis: string) => string
  readonly backOff: (order: string, backOff: string) => string
  readonly probingConfigured: string
  readonly probingNone: string
  readonly relays: string
}

export type CapabilityId = 'homing' | 'probing' | 'coolant' | 'softLimits' | 'ramps'
export interface CapabilityRow { readonly id: CapabilityId; readonly value: string }

export function capabilityRows(machine: MachineConfig | undefined, w: CapabilityWords): readonly CapabilityRow[] {
  const definition = machine?.controllerDefinition
  const backOff = definition && machine
    ? definition.homing.order.map(axis => {
        const value = definition.homing.perAxis[axis]?.backOff
        return value === undefined || !backOffIsStated(machine, axis) ? w.axisNotStated(axis) : `${axis} ${value}`
      }).join(', ')
    : w.notConfigured
  const softLimits = definition && machine
    ? definition.axes.filter(a => a.enabled)
      .map(a => softLimitsAreStated(machine, a.axis) ? `${a.axis} ${a.softLimitMin}..${a.softLimitMax}` : w.axisNotStated(a.axis))
      .join(', ')
    : w.notConfigured
  return [
    { id: 'homing', value: definition ? w.backOff(definition.homing.order.join(' -> '), backOff) : backOff },
    { id: 'probing', value: machine?.probing ? w.probingConfigured : w.probingNone },
    { id: 'coolant', value: w.relays },
    { id: 'softLimits', value: softLimits },
    { id: 'ramps', value: w.notConfigured },
  ]
}
