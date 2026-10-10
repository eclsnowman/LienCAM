// WO-1688 - the definition page's Overview tab, one fact list per card.
// v2/SLICES.md T5 (Q2): "five cards from the record. Pure read: each card's
// lines come from one overviewFacts(machine) function so the walkthrough's
// review step (T13) reuses them."
//
// PURE AND READ-ONLY. This reads `MachineConfig` and returns plain-word
// sentences; it never edits the record and never talks to a controller. The
// same reason `WiringSection`/`ModbusSection`/`ProbingSection` exist as
// separate legacy renderers applies here in reverse - THIS is the one place
// that turns the record into the Overview's words, so a later area order
// (WO-1690..1694) reuses these lines instead of writing its own copy that can
// drift from what the card above it says.
//
// NEVER INVENT A MACHINE FACT (see MachineDefinitionPanel.tsx's file header,
// rule 3). Every sentence below either reads a typed field
// (`controllerDefinition.axes/homing/io/outputs`) or a value the profile
// itself stated (`unsentSettingValue`/`controllerSettingValue`) - nothing
// here substitutes a default for an absent value.

import {
  type AxisName,
  type MachineConfig,
  type PinRef,
  controllerSettingValue,
  describeSkew,
  isPinAssigned,
  machineSkew,
  unsentSettingValue,
  validateControllerDefinition,
} from '../../types'
import { resolveHomingOrder } from './controller'
import { axisSoftLimitState, axisSoftLimitsAreStated } from './resolvedMachineMotion'
import { outputTurnedOff } from './machineOutputs'

/** The axes `resolveMachineMotion` bounds (its own AXES list: x, y, z). */
const SESSION_BOUNDED_AXES: readonly AxisName[] = ['X', 'Y', 'Z']

export interface OverviewFacts {
  machine: string[]
  spindle: string[]
  outputs: string[]
  probing: string[]
  controller: string[]
}

function pinText(pin: PinRef): string {
  return isPinAssigned(pin) ? `${pin.port}:${pin.pin}` : 'not wired'
}

/** A setting's own value as text, typed first (`controllerDefinition.settings`,
 *  WO-1037) then the pre-model text carrier (`unsentSettings`, WO-947) -
 *  `stored()` in `DefinitionFields.createSettingSource` reads the same two
 *  containers in the same order, so this agrees with what the Legacy tab
 *  already shows for the same key. */
function settingText(machine: MachineConfig, key: string): string | null {
  const typed = machine.controllerDefinition
    ? controllerSettingValue(machine.controllerDefinition.settings, machine.controller, key)
    : null
  if (typed) return typed.kind === 'tuple' ? null : String(typed.value)
  return unsentSettingValue(machine.unsentSettings, machine.controller, key)
}

/** Same two containers as `settingText`, read as a boolean: the typed model
 *  holds a real `boolean`, while the text carrier holds the controller's own
 *  spelling ("True"/"False" for UCCNC) verbatim. */
function settingIsTrue(machine: MachineConfig, key: string): boolean {
  const typed = machine.controllerDefinition
    ? controllerSettingValue(machine.controllerDefinition.settings, machine.controller, key)
    : null
  if (typed?.kind === 'boolean') return typed.value
  return (unsentSettingValue(machine.unsentSettings, machine.controller, key) ?? '').toLowerCase() === 'true'
}

function homeEnd(direction: 'positive' | 'negative'): 'max' | 'min' {
  return direction === 'positive' ? 'max' : 'min'
}

/** The XY corner homing settles on - the fact an operator reads off the
 *  machine, not Z's own direction. Z's search direction is a safety
 *  convention (see `DEFAULT_HOMING_ORDER`), not part of "which corner". */
function homeCornerLine(machine: MachineConfig): string {
  const def = machine.controllerDefinition
  // The order homing will actually send - `resolveHomingOrder` is the one
  // place that falls back to the default when the record names none.
  const order = resolveHomingOrder(def)
  const isDefault = (def?.homing?.order?.length ?? 0) === 0
  const corner = (['X', 'Y'] as const)
    .filter((axis) => order.includes(axis))
    .map((axis) => {
      const perAxis = def?.homing?.perAxis[axis]
      return perAxis ? `${axis} ${homeEnd(perAxis.direction)}` : null
    })
    .filter((line): line is string => line !== null)
  return `Home: ${order.join(' then ')}${isDefault ? ' (default order)' : ''}`
    + `${corner.length > 0 ? ` - at ${corner.join(', ')}` : ''}`
}

/** Why the session does not enforce an axis's soft limits, in plain words.
 *  Reads only the session's own functions (`axisSoftLimitState`,
 *  `axisSoftLimitsAreStated`) - no second copy of the enforcement rule. */
function softLimitGap(machine: MachineConfig, axis: AxisName): string {
  const state = axisSoftLimitState(machine, axis)
  if (state === 'invalid') return 'limits out of order'
  if (!axisSoftLimitsAreStated(machine, axis)) return 'no limit stated'
  return 'switched off'
}

/** Soft limits per axis, exactly as the session enforces them: an axis is
 *  "enforced" only when `resolveMachineMotion` would mark it 'bounded'. */
function softLimitsLine(machine: MachineConfig): string {
  const axes = (machine.controllerDefinition?.axes ?? [])
    .filter((a) => a.enabled && SESSION_BOUNDED_AXES.includes(a.axis))
    .map((a) => a.axis)
  const enforced = axes.filter((axis) => axisSoftLimitState(machine, axis) === 'bounded')
  const gaps = new Map<string, AxisName[]>()
  for (const axis of axes) {
    if (enforced.includes(axis)) continue
    const why = softLimitGap(machine, axis)
    gaps.set(why, [...(gaps.get(why) ?? []), axis])
  }
  const notParts = [...gaps.entries()].map(([why, list]) => `${list.join(' ')} not (${why})`)
  if (enforced.length === 0) {
    return `Soft limits: none enforced${gaps.size === 1 ? ` (${[...gaps.keys()][0]})` : notParts.length > 0 ? ` - ${notParts.join(', ')}` : ''}`
  }
  return `Soft limits: ${enforced.join(' ')} enforced${notParts.length > 0 ? `, ${notParts.join(', ')}` : ''}`
}

function machineLines(machine: MachineConfig): string[] {
  const def = machine.controllerDefinition
  const enabled = def?.axes.filter((a) => a.enabled) ?? []
  const lines: string[] = []

  const slaveNotes = enabled
    .filter((a) => a.slaveAxis)
    .map((a) => `${a.slaveAxis} follows ${a.axis}`)
  lines.push(
    `Axes: ${enabled.map((a) => a.axis).join(' ') || 'none defined'}`
    + (slaveNotes.length > 0 ? ` (${slaveNotes.join(', ')})` : ''),
  )

  lines.push(`Travel: X ${machine.travel.x} x Y ${machine.travel.y} x Z ${machine.travel.z} mm`)
  lines.push(homeCornerLine(machine))

  if (enabled.length > 0) {
    lines.push(`Steps per mm: ${enabled.map((a) => a.stepsPerUnit).join(' / ')}`)
  }

  lines.push(softLimitsLine(machine))

  lines.push(`Gantry skew: ${describeSkew(machineSkew(machine)).toLowerCase()}`)
  return lines
}

/** Drive kind, kept to what this order needs (the full VFD / relay+PWM /
 *  relay only / PWM-from-board / none taxonomy belongs to the Spindle area,
 *  WO-1691 - this only says whether a Modbus link drives the spindle, which
 *  is all Operator's own machine and the acceptance sentence need today). */
function spindleDriveLine(machine: MachineConfig): string {
  const modbusEnabled = settingIsTrue(machine, 'Modbus_connection_0.Enabled')
  const drivenByModbus = machine.spindleLinkDefinition != null || modbusEnabled
  if (drivenByModbus) return 'Drive: VFD over Modbus'
  const outputs = machine.controllerDefinition?.outputs ?? []
  if (outputs.some((o) => o.besideWord)) return "Drive: a relay beside the controller's own spindle word"
  return "Drive: the controller's own spindle output"
}

function spindleLinkLine(machine: MachineConfig): string {
  const link = machine.spindleLinkDefinition
  if (link) {
    return `Link: ${
      link.link.transport === 'rtu'
        ? `${link.link.port} at ${link.link.baud} baud`
        : `${link.link.host}:${link.link.tcpPort}`
    }`
  }
  const port = settingText(machine, 'Modbus_connection_0.Serial_Comport')
  const baud = settingText(machine, 'Modbus_connection_0.Serial_Baudrate')
  return `Link: ${port && baud ? `${port} at ${baud} baud` : 'not linked'}`
}

function spindleLines(machine: MachineConfig): string[] {
  const speed = machine.minSpindleRpm === undefined && machine.maxSpindleRpm === undefined
    ? 'Speed: not set'
    : `Speed: ${machine.minSpindleRpm ?? 'not set'} - ${machine.maxSpindleRpm ?? 'not set'} rpm`
  return [
    spindleDriveLine(machine),
    speed,
    spindleLinkLine(machine),
    `Direction: ${machine.spindleDirection === 'cw' ? 'clockwise' : 'counter-clockwise'}`,
  ]
}

function outputLines(machine: MachineConfig): string[] {
  const outputs = machine.controllerDefinition?.outputs ?? []
  if (outputs.length === 0) return ['Outputs: none defined']
  return outputs.map((o) => (
    `${o.name}: ${o.onCode}${isPinAssigned(o.pin) ? ` - port ${o.pin.port} pin ${o.pin.pin}` : ' - not wired'}`
    + (outputTurnedOff(o, outputs) ? ', turned off' : '')
    + (o.onDelayMs ? `, ${o.onDelayMs} ms on` : '')
  ))
}

function probingLines(machine: MachineConfig): string[] {
  const def = machine.controllerDefinition
  return [
    `Probe input: ${def ? pinText(def.io.probe) : 'not wired'}`,
    `Tool setter: ${def ? pinText(def.io.probe2) : 'not wired'}`,
  ]
}

function controllerLines(machine: MachineConfig): string[] {
  const def = machine.controllerDefinition
  const problems = def ? validateControllerDefinition(def) : []
  return [
    `Controller: ${machine.controller.toUpperCase()}`,
    `E-stop: ${def ? pinText(def.io.estop) : 'not wired'}`,
    `Faults: ${problems.length === 0 ? 'none found' : `${problems.length} to fix`}`,
  ]
}

/** One pure read of the machine record, five cards' worth of plain-word
 *  lines. Nothing downstream (`OverviewCards.tsx`, WO-1696's walkthrough
 *  review step) computes its own copy of these facts - it reuses this. */
export function overviewFacts(machine: MachineConfig): OverviewFacts {
  return {
    machine: machineLines(machine),
    spindle: spindleLines(machine),
    outputs: outputLines(machine),
    probing: probingLines(machine),
    controller: controllerLines(machine),
  }
}
