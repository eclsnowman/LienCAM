import {
  createDefaultAxisHomingDefinition,
  type AxisName,
  type MachineConfig,
} from '../../../types'

export type GrblSettingKind = 'number' | 'mask' | 'bool'

export interface GrblSettingDefinition {
  name: string
  unit: string
  kind: GrblSettingKind
  maskBits?: readonly string[]
}

export type GrblSettingsRecord = Record<number, string>

export function isGrblMachine(machine: Pick<MachineConfig, 'controller'>): boolean {
  // TODO WO-1113: replace this temporary type gate with controllerSurface.
  return machine.controller === 'grbl'
}

// MachineConfig's declaration is outside WO-1115's owned paths. Augment the
// existing persisted record from the GRBL vocabulary module so the controller
// copy remains a first-class machine fact without opening a second store.
declare module '../../../types' {
  interface MachineConfig {
    grblSettings?: GrblSettingsRecord
  }
}

const axes = ['X', 'Y', 'Z'] as const

export const GRBL_SETTINGS: Readonly<Record<number, GrblSettingDefinition>> = {
  0: { name: 'Step pulse time', unit: 'us', kind: 'number' },
  1: { name: 'Step idle delay', unit: 'ms', kind: 'number' },
  2: { name: 'Step pulse invert', unit: 'axis mask', kind: 'mask', maskBits: axes },
  3: { name: 'Step direction invert', unit: 'axis mask', kind: 'mask', maskBits: axes },
  4: { name: 'Invert step enable pin', unit: 'on/off', kind: 'bool' },
  5: { name: 'Invert limit pins', unit: 'on/off', kind: 'bool' },
  6: { name: 'Invert probe pin', unit: 'on/off', kind: 'bool' },
  10: {
    name: 'Status report options', unit: 'field mask', kind: 'mask',
    maskBits: ['machine position', 'buffer state'],
  },
  11: { name: 'Junction deviation', unit: 'mm', kind: 'number' },
  12: { name: 'Arc tolerance', unit: 'mm', kind: 'number' },
  13: { name: 'Report in inches', unit: 'on/off', kind: 'bool' },
  20: { name: 'Soft limits', unit: 'on/off', kind: 'bool' },
  21: { name: 'Hard limits', unit: 'on/off', kind: 'bool' },
  22: { name: 'Homing cycle', unit: 'on/off', kind: 'bool' },
  23: { name: 'Homing direction invert', unit: 'axis mask', kind: 'mask', maskBits: axes },
  24: { name: 'Homing locate feed', unit: 'mm/min', kind: 'number' },
  25: { name: 'Homing search seek', unit: 'mm/min', kind: 'number' },
  26: { name: 'Homing switch debounce', unit: 'ms', kind: 'number' },
  27: { name: 'Homing switch pull-off', unit: 'mm', kind: 'number' },
  30: { name: 'Maximum spindle speed', unit: 'rpm', kind: 'number' },
  31: { name: 'Minimum spindle speed', unit: 'rpm', kind: 'number' },
  32: { name: 'Laser mode', unit: 'on/off', kind: 'bool' },
  100: { name: 'X steps per mm', unit: 'steps/mm', kind: 'number' },
  101: { name: 'Y steps per mm', unit: 'steps/mm', kind: 'number' },
  102: { name: 'Z steps per mm', unit: 'steps/mm', kind: 'number' },
  110: { name: 'X maximum rate', unit: 'mm/min', kind: 'number' },
  111: { name: 'Y maximum rate', unit: 'mm/min', kind: 'number' },
  112: { name: 'Z maximum rate', unit: 'mm/min', kind: 'number' },
  120: { name: 'X acceleration', unit: 'mm/sec^2', kind: 'number' },
  121: { name: 'Y acceleration', unit: 'mm/sec^2', kind: 'number' },
  122: { name: 'Z acceleration', unit: 'mm/sec^2', kind: 'number' },
  130: { name: 'X maximum travel', unit: 'mm', kind: 'number' },
  131: { name: 'Y maximum travel', unit: 'mm', kind: 'number' },
  132: { name: 'Z maximum travel', unit: 'mm', kind: 'number' },
}

export interface ParsedGrblSetting {
  id: number
  value: string
}

export function parseGrblSetting(line: string): ParsedGrblSetting | null {
  const match = /^\$(\d+)=([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/.exec(line.trim())
  if (!match) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? { id, value: match[2] } : null
}

export function formatGrblSetting(id: number, value: string): string | null {
  const trimmed = value.trim()
  if (!Number.isSafeInteger(id) || id < 0) return null
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return null
  return `$${id}=${trimmed}`
}

export function formatGrblMask(value: string, bits: readonly string[]): string {
  const mask = Number(value)
  if (!Number.isSafeInteger(mask) || mask < 0) return 'invalid mask'
  const enabled = bits.filter((_, bit) => (mask & (1 << bit)) !== 0)
  const knownMask = bits.reduce((sum, _, bit) => sum | (1 << bit), 0)
  const unknown = mask & ~knownMask
  if (unknown !== 0) enabled.push(`other bits ${unknown}`)
  return enabled.length > 0 ? enabled.join(', ') : 'none'
}

export function cloneGrblSettings(machine: Pick<MachineConfig, 'grblSettings'>): GrblSettingsRecord {
  return { ...(machine.grblSettings ?? {}) }
}

const GRBL_AXIS_SETTING_FIELDS = [
  { base: 100, field: 'stepsPerUnit' },
  { base: 110, field: 'maxVelocity' },
  { base: 120, field: 'acceleration' },
] as const

function grblNumber(settings: GrblSettingsRecord, id: number): number | null {
  const raw = settings[id]
  if (raw === undefined || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim())) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

export function grblFlag(settings: GrblSettingsRecord, id: number): boolean | null {
  const value = grblNumber(settings, id)
  return value === null ? null : value !== 0
}

export function grblMaskBit(settings: GrblSettingsRecord, id: number, bit: number): boolean | null {
  const value = grblNumber(settings, id)
  return value === null || !Number.isSafeInteger(value) || value < 0
    ? null
    : (value & (1 << bit)) !== 0
}

/** Keep the persisted controller copy and the legacy machine fields consumed
 * by planning in lockstep. GRBL rows remain authoritative; these mirrors keep
 * consumers that predate the GRBL table from planning with stale hidden data. */
export function recordGrblSettings(
  machine: MachineConfig,
  settings: GrblSettingsRecord,
): MachineConfig {
  const controllerDefinition = machine.controllerDefinition
  const travel = { ...machine.travel }
  const axisTravel = [130, 131, 132].map((id) => grblNumber(settings, id))
  for (const [index, axis] of (['x', 'y', 'z'] as const).entries()) {
    if (axisTravel[index] !== null) travel[axis] = Math.abs(axisTravel[index])
  }

  const maxSpindleRpm = grblNumber(settings, 30) ?? machine.maxSpindleRpm
  const minSpindleRpm = grblNumber(settings, 31) ?? machine.minSpindleRpm
  const homingEnabled = grblFlag(settings, 22)
  const baseMachine = {
    ...machine,
    travel,
    maxSpindleRpm,
    minSpindleRpm,
    ...(homingEnabled === null ? {} : { noHomingSwitches: !homingEnabled }),
    grblSettings: { ...settings },
  }
  if (!controllerDefinition) return baseMachine

  const axes = controllerDefinition.axes.map((axis) => {
    const offset = axis.axis === 'X' ? 0 : axis.axis === 'Y' ? 1 : axis.axis === 'Z' ? 2 : null
    if (offset === null) return axis
    let next = axis
    for (const { base, field } of GRBL_AXIS_SETTING_FIELDS) {
      const value = grblNumber(settings, base + offset)
      if (value !== null) next = { ...next, [field]: value }
    }
    const maximumTravel = axisTravel[offset]
    if (maximumTravel !== null) {
      next = { ...next, softLimitMin: -Math.abs(maximumTravel), softLimitMax: 0 }
    }
    const directionInverted = grblMaskBit(settings, 3, offset)
    if (directionInverted !== null) {
      next = { ...next, dirPin: { ...next.dirPin, negate: directionInverted } }
    }
    const limitsInverted = grblFlag(settings, 5)
    if (limitsInverted !== null) {
      next = {
        ...next,
        homePin: { ...next.homePin, negate: limitsInverted },
        limitMinusPin: { ...next.limitMinusPin, negate: limitsInverted },
        limitPlusPin: { ...next.limitPlusPin, negate: limitsInverted },
      }
    }
    return next
  })

  const perAxis = { ...controllerDefinition.homing.perAxis }
  for (const [offset, axisName] of (['X', 'Y', 'Z'] as const).entries()) {
    const directionInverted = grblMaskBit(settings, 23, offset)
    const slowSpeed = grblNumber(settings, 24)
    const fastSpeed = grblNumber(settings, 25)
    const backOff = grblNumber(settings, 27)
    if ([directionInverted, slowSpeed, fastSpeed, backOff].every((value) => value === null)) continue
    const axis = axes.find((candidate) => candidate.axis === axisName)
    const current = perAxis[axisName]
      ?? createDefaultAxisHomingDefinition(axisName as AxisName, axis?.maxVelocity)
    perAxis[axisName] = {
      ...current,
      ...(directionInverted === null ? {} : { direction: directionInverted ? 'negative' : 'positive' }),
      ...(slowSpeed === null ? {} : { slowSpeed }),
      ...(fastSpeed === null ? {} : { fastSpeed }),
      ...(backOff === null ? {} : { backOff }),
    }
  }

  return {
    ...baseMachine,
    controllerDefinition: {
      ...controllerDefinition,
      axes,
      homing: { ...controllerDefinition.homing, perAxis },
    },
  }
}
