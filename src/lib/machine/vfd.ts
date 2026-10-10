import { HUANYANG_GT } from './vfd/huanyangGt'
import type { VfdDefinition, VfdLink, VfdRequiredParameter } from './vfd/vfdDefinition'
import type { MachineSpindleLinkDefinition } from '../../types'

// WO-1354 - public VFD entry point plus the live spindle-override calculation.
//
// The UC100 spindle override and the Modbus inverter are separate outputs. The
// controller can report a changed SRO while the inverter continues holding its
// previous setpoint, so an active command has to be recomputed and sent to both.

export * from './vfd/index'

// WO-1718 - A VFD IS DECLARED IN THE MACHINE DEFINITION, FROM A NAMED MODEL.
//
// Operator ruling 2026-09-19: "The machine definition IS the source of truth ... The
// bridge is the mechanism to communicate, not the definition." Choosing
// "Modbus VFD" as the Drive copies one of these into the machine record, and
// every field is editable there. The bridge never reads a file for it.

/** WO-1718 review 2: A REQUIRED KEYPAD PARAMETER THAT RESTATES A LINK FIELD
 *  FOLLOWS IT. Huanyang's PC.00 (slave address), PC.01 (baud) and PC.02
 *  (framing) say "set the inverter to what this link uses" - the value is the
 *  link's own field, not a second copy of it. A row marked `follows` has its
 *  value computed from the link on every store, and its value cell edits the
 *  link field itself, so the two can never disagree. A row with no `follows`
 *  (P0.01, P0.07, PC.05, anything the operator adds) is its own fact and is
 *  edited as text. */
export type VfdParameterFollows = 'slaveAddress' | 'baud' | 'framing'

export type VfdRequiredParameterRow = VfdRequiredParameter & { follows?: VfdParameterFollows }

export const VFD_PARAMETER_FOLLOWS: readonly VfdParameterFollows[] = ['slaveAddress', 'baud', 'framing']

const PARITY_LETTER: Record<string, string> = { none: 'N', even: 'E', odd: 'O' }

/** The link fields a followed value is made of, in display order. Empty when
 *  the link has none of them (baud and framing over TCP): the row then stands
 *  as its own text. */
export function vfdFollowedFields(link: VfdLink, follows: VfdParameterFollows): string[] {
  if (follows === 'slaveAddress') return ['slaveAddress']
  if (link.transport !== 'rtu') return []
  return follows === 'baud' ? ['baud'] : ['dataBits', 'parity', 'stopBits']
}

/** The keypad text a followed row states, from the link - or null when this
 *  link has no such field (the row keeps its own text). */
export function vfdFollowedValue(link: VfdLink, follows: VfdParameterFollows): string | null {
  if (vfdFollowedFields(link, follows).length === 0) return null
  if (follows === 'slaveAddress') return `slave address ${link.slaveAddress}`
  if (link.transport !== 'rtu') return null
  if (follows === 'baud') return `${link.baud} baud`
  return `${link.dataBits}-${PARITY_LETTER[link.parity] ?? link.parity}-${link.stopBits}`
}

/** The definition with every followed row's value restated from its link.
 *  Every store goes through this, so the stored text is the link's. */
export function withFollowedParameters<T extends { link: VfdLink; requiredParameters: VfdRequiredParameter[] }>(
  definition: T,
): T {
  const rows = definition.requiredParameters as VfdRequiredParameterRow[] | undefined
  if (!Array.isArray(rows) || !rows.some((row) => row.follows !== undefined)) return definition
  return {
    ...definition,
    requiredParameters: rows.map((row) => {
      if (row.follows === undefined) return row
      const value = vfdFollowedValue(definition.link, row.follows)
      return value === null || value === row.value ? row : { ...row, value }
    }),
  }
}

export interface VfdModelTemplate {
  id: string
  /** What the Drive picker calls it. */
  label: string
  definition: VfdDefinition
  /** Which of the model's required keypad parameters restate a link field. */
  parameterFollows?: Readonly<Record<string, VfdParameterFollows>>
}

/** Named inverter models a link can start from. Huanyang GT first (Operator's). */
export const VFD_MODEL_TEMPLATES: readonly VfdModelTemplate[] = [
  {
    id: HUANYANG_GT.id,
    label: HUANYANG_GT.name,
    definition: HUANYANG_GT,
    parameterFollows: { 'PC.00': 'slaveAddress', 'PC.01': 'baud', 'PC.02': 'framing' },
  },
]

export function vfdModelTemplate(templateId: string): VfdModelTemplate | null {
  return VFD_MODEL_TEMPLATES.find((template) => template.id === templateId) ?? null
}

/** A complete, independent copy of a template, owned by `machineId`'s
 *  definition. Not verified: nobody has run this link against this machine's
 *  inverter yet. */
export function vfdLinkFromTemplate(
  templateId: string,
  machineId: string,
): MachineSpindleLinkDefinition | null {
  const template = vfdModelTemplate(templateId)
  if (template === null) return null
  const copy = JSON.parse(JSON.stringify(template.definition)) as VfdDefinition
  const follows = template.parameterFollows ?? {}
  return withFollowedParameters<MachineSpindleLinkDefinition>({
    ...copy,
    requiredParameters: copy.requiredParameters.map((row): VfdRequiredParameterRow => (
      follows[row.parameter] === undefined ? row : { ...row, follows: follows[row.parameter] }
    )),
    verified: false,
    provenance: {
      kind: 'edited-here',
      source: `LienCAM machine ${machineId} - declared from the ${template.label} template`,
    },
  })
}

export type LiveSpindleOverrideChange =
  | { kind: 'feed' | 'rapid' | 'spindle'; to: 'reset' }
  | { kind: 'feed' | 'rapid' | 'spindle'; to: 'percent'; percent: number }
  | {
      kind: 'feed' | 'rapid' | 'spindle'
      to: 'step'
      direction: 1 | -1
      coarse: boolean
    }

export interface LiveSpindleOverrideResolution {
  requestedPercent: number
  appliedPercent: number
  effectiveRpm: number
  clamped: boolean
}

/**
 * Resolve one panel gesture against the last percentage sent during this
 * spindle run. Returning null means the gesture is not a spindle change, or a
 * step has no honest starting percentage; callers then preserve the existing
 * controller path without inventing an inverter command.
 */
export function resolveLiveSpindleOverride(
  baseRpm: number,
  maximumRpm: number,
  currentPercent: number | null,
  change: LiveSpindleOverrideChange,
): LiveSpindleOverrideResolution | null {
  if (change.kind !== 'spindle') return null

  let requestedPercent: number
  if (change.to === 'reset') requestedPercent = 100
  else if (change.to === 'percent') requestedPercent = change.percent
  else {
    if (currentPercent === null || !Number.isFinite(currentPercent)) return null
    requestedPercent = currentPercent + change.direction * (change.coarse ? 10 : 1)
  }

  if (!Number.isFinite(baseRpm) || baseRpm <= 0 || !Number.isFinite(maximumRpm) || maximumRpm <= 0) {
    return null
  }
  const maximumPercent = maximumRpm / baseRpm * 100
  const appliedPercent = Math.min(requestedPercent, maximumPercent)
  return {
    requestedPercent,
    appliedPercent,
    effectiveRpm: Math.min(maximumRpm, baseRpm * appliedPercent / 100),
    clamped: appliedPercent !== requestedPercent,
  }
}

export function spindleMaximumNotice(maximumRpm: number): string {
  return `${maximumRpm.toLocaleString('en-US')} is this spindle's maximum.`
}

export interface LiveSpindleOverrideRoute {
  baseRpm: number
  maximumRpm: number
  currentPercent: number | null
  direction: 'cw' | 'ccw'
  maximumNoticeSaid: boolean
  sendOverride: (change: LiveSpindleOverrideChange) => void
  sendSpindle: (direction: 'cw' | 'ccw', rpm: number) => boolean
  announce: (sentence: string) => void
}

/** Send the controller percentage and inverter setpoint as one decision. */
export function routeLiveSpindleOverride(
  route: LiveSpindleOverrideRoute,
  change: LiveSpindleOverrideChange,
): LiveSpindleOverrideResolution | null {
  const resolved = resolveLiveSpindleOverride(
    route.baseRpm,
    route.maximumRpm,
    route.currentPercent,
    change,
  )
  if (resolved === null) {
    route.sendOverride(change)
    return null
  }

  route.sendOverride({ kind: 'spindle', to: 'percent', percent: resolved.appliedPercent })
  route.sendSpindle(route.direction, resolved.effectiveRpm)
  if (resolved.clamped && !route.maximumNoticeSaid) {
    route.announce(spindleMaximumNotice(route.maximumRpm))
  }
  return resolved
}
