import {
  controllerSettingBoolean,
  definitionStatesAxisSoftLimits,
  definitionStatesKey,
  machineHomeConvention,
  machineRapidRate,
  machineTravel,
  type AxisName,
  type MachineConfig,
  type MachineHomeConvention,
} from '../../types'
import {
  deriveAxisEnvelopeFromHome,
  deriveMachineEnvelope,
  deriveMachineEnvelopeFromConvention,
  type AxisEnvelope,
  type EnvelopeAxisId,
  type MachineEnvelope,
} from './machineEnvelope'

// WO-1987: 'gateway' (LinuxCNC) has no live-limit readback yet, so it reads
// the configured profile, as an unknown route always has.
export type MotionConnectionKind = 'serial' | 'simulator' | 'bridge' | 'gateway' | null
export type MotionRangeSource =
  | 'pinned-profile'
  | 'profile-controller-definition'
  | 'live-grbl-settings'
  | 'live-uccnc-definition'

export interface ResolvedMotionRange {
  min: number
  max: number
  source: MotionRangeSource
  reason: string
}

export type DefinitionAxisState =
  | 'missing-definition'
  | 'undefined'
  | 'disabled'
  | 'unknown'
  | 'invalid'
  | 'bounded'

export interface ResolvedMachineAxisMotion {
  axis: AxisName
  physical: ResolvedMotionRange | null
  controller: ResolvedMotionRange | null
  effective: ResolvedMotionRange | null
  definitionState: DefinitionAxisState
  state: 'bounded' | 'unknown' | 'invalid' | 'conflict'
  reason: string
  homesToward: 'min' | 'max' | null
  machineZeroAt: 'min' | 'max' | 'legacy-position' | null
  rapidMmMin: number | null
  maxVelocityMmMin: number | null
}

export interface ResolvedMachineMotion {
  authority: 'simulator-profile' | 'live-grbl' | 'live-uccnc' | 'configured-profile'
  machineId: string
  machineName: string
  axes: Record<EnvelopeAxisId, ResolvedMachineAxisMotion>
  envelope: MachineEnvelope
  /** Transport-reported geometry retained for diagnostics only. It never
   * replaces the effective authority above. */
  reportedEnvelope: MachineEnvelope
  datum: {
    known: boolean
    source: 'homed-session' | 'manual-session-datum' | 'configured-only' | 'unknown'
    reason: string
    axes: Record<EnvelopeAxisId, {
      known: boolean
      source: 'homed-session' | 'manual-session-datum' | 'configured-only' | 'unknown'
      reason: string
    }>
  }
  rapidMmMin: number | null
  diagnostics: string[]
}

export interface ResolveMachineMotionInput {
  machine: MachineConfig
  connectionKind: MotionConnectionKind
  settings?: Record<number, string>
  datumKnown?: boolean | Partial<Record<AxisName, boolean>>
}

const AXES: ReadonlyArray<{ key: EnvelopeAxisId; label: AxisName }> = [
  { key: 'x', label: 'X' },
  { key: 'y', label: 'Y' },
  { key: 'z', label: 'Z' },
]

export function resolvedMotionCoversAddressedAxes(
  motion: ResolvedMachineMotion,
  addressedAxes: Partial<Record<EnvelopeAxisId, unknown>>,
): boolean {
  return AXES.every(({ key }) => addressedAxes[key] === undefined || motion.axes[key].effective !== null)
}

const UCCNC_SOFT_LIMIT_ENABLED = 'Generalsettings.Softlimitsenable'
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0
}

export function axisSoftLimitStatementKey(axis: AxisName, end: 'min' | 'max'): string {
  return `liencam.axes.${axis}.${end === 'min' ? 'softLimitMin' : 'softLimitMax'}`
}

/** True only when both ends came from a person/import, never from the numeric
 * placeholders on createDefaultAxisDefinition. */
export function axisSoftLimitsAreStated(machine: MachineConfig, axis: AxisName): boolean {
  return definitionStatesAxisSoftLimits(machine, axis)
}

function appAxisSoftLimitsAreStated(machine: MachineConfig, axis: AxisName): boolean {
  const definition = machine.controllerDefinition
  const configured = definition?.axes.find((candidate) => candidate.axis === axis)
  return Boolean(definition && configured
    && definitionStatesKey(definition, machine.controller, axisSoftLimitStatementKey(axis, 'min'))
    && definitionStatesKey(definition, machine.controller, axisSoftLimitStatementKey(axis, 'max')))
}

function controllerSoftLimitsEnabled(machine: MachineConfig, axis: AxisName): boolean {
  if (appAxisSoftLimitsAreStated(machine, axis)) return true
  if (machine.controller !== 'uccnc') return false
  return controllerSettingBoolean(
    machine.controllerDefinition?.settings,
    'uccnc',
    UCCNC_SOFT_LIMIT_ENABLED,
  ) === true
}

function profileRange(
  envelope: MachineEnvelope,
  axis: EnvelopeAxisId,
  machine: MachineConfig,
): ResolvedMotionRange | null {
  const value = envelope[axis]
  if (!value) return null
  // WO-1698: once the definition states this axis's soft limits they ARE its
  // travel (machineTravel), already in machine coordinates - read them where
  // they sit. Re-anchoring their span at the convention's zero and then
  // intersecting with the same limits would shrink the stated range.
  const label = axis.toUpperCase() as AxisName
  const configured = machine.controllerDefinition?.axes.find((candidate) => candidate.axis === label)
  const stated = configured && definitionStatesAxisSoftLimits(machine, label)
    && configured.softLimitMax > configured.softLimitMin
  return {
    min: stated ? configured.softLimitMin : value.min,
    max: stated ? configured.softLimitMax : value.max,
    source: 'pinned-profile',
    reason: `${machine.name} Machine-page travel and coordinate convention`,
  }
}

function definitionState(
  machine: MachineConfig,
  axis: AxisName,
): DefinitionAxisState {
  const definition = machine.controllerDefinition
  if (!definition) return 'missing-definition'
  const configured = definition.axes.find((candidate) => candidate.axis === axis)
  if (!configured) return 'undefined'
  if (!configured.enabled) return 'disabled'
  if (!axisSoftLimitsAreStated(machine, axis) || !controllerSoftLimitsEnabled(machine, axis)) {
    return 'unknown'
  }
  if (!finite(configured.softLimitMin) || !finite(configured.softLimitMax)
    || configured.softLimitMax <= configured.softLimitMin) return 'invalid'
  return 'bounded'
}

/** Read-only view of the session's own per-axis soft-limit answer (the same
 * `definitionState` `resolveMachineMotion` uses; 'bounded' means the session
 * enforces that axis's limits). For display (WO-1688 Overview) - never a
 * second copy of the rule. */
export function axisSoftLimitState(machine: MachineConfig, axis: AxisName): DefinitionAxisState {
  return definitionState(machine, axis)
}

function controllerRange(
  machine: MachineConfig,
  connectionKind: MotionConnectionKind,
  axis: AxisName,
  state: DefinitionAxisState,
): ResolvedMotionRange | null {
  if (state !== 'bounded') return null
  const configured = machine.controllerDefinition!.axes.find((candidate) => candidate.axis === axis)!
  return {
    min: configured.softLimitMin,
    max: configured.softLimitMax,
    source: connectionKind === 'bridge' ? 'live-uccnc-definition' : 'profile-controller-definition',
    reason: connectionKind === 'bridge'
      ? `read-back or pinned applied ${machine.controller.toUpperCase()} controller definition`
      : `explicitly stated and enabled ${machine.controller.toUpperCase()} controller limits`,
  }
}

function intersectRanges(
  physical: ResolvedMotionRange | null,
  controller: ResolvedMotionRange | null,
): { range: ResolvedMotionRange | null; conflict: boolean } {
  if (!physical) return { range: controller, conflict: false }
  if (!controller) return { range: physical, conflict: false }
  const min = Math.max(physical.min, controller.min)
  const max = Math.min(physical.max, controller.max)
  if (!(max > min)) return { range: null, conflict: true }
  return {
    range: {
      min,
      max,
      source: controller.source,
      reason: `intersection of ${physical.reason} and ${controller.reason}`,
    },
    conflict: false,
  }
}

function rangeEnvelope(
  range: ResolvedMotionRange | null,
  convention: MachineHomeConvention[EnvelopeAxisId] | undefined,
): AxisEnvelope | null {
  if (!range) return null
  const homesToward = convention?.homesToward ?? 'min'
  // WO-1701: the range's own ends, not re-derived from home - travel, so the
  // orientation a home end gives never moves an end by floating-point dust.
  return {
    ...deriveAxisEnvelopeFromHome({
      travelMm: range.max - range.min,
      homesToward,
      homePositionMm: homesToward === 'max' ? range.max : range.min,
    }),
    min: range.min,
    max: range.max,
  }
}

function datum(
  machine: MachineConfig,
  connectionKind: MotionConnectionKind,
  known: boolean | Partial<Record<AxisName, boolean>>,
): ResolvedMachineMotion['datum'] {
  const sourceWhenKnown = machine.noHomingSwitches === true
    ? 'manual-session-datum' as const
    : 'homed-session' as const
  const reasonWhenKnown = machine.noHomingSwitches === true
    ? 'the operator established this session datum manually'
    : 'the controller established this session datum by homing'
  const unknownSource = connectionKind === null ? 'configured-only' as const : 'unknown' as const
  const unknownReason = connectionKind === null
    ? 'configured geometry is available, but no live session datum exists'
    : machine.noHomingSwitches === true
      ? 'this switchless machine needs a manual session datum'
      : 'this session has not established machine coordinates by homing'
  const axisKnown = (axis: AxisName): boolean => typeof known === 'boolean' ? known : known[axis] === true
  const axes = Object.fromEntries(AXES.map(({ key, label }) => {
    const isKnown = axisKnown(label)
    return [key, {
      known: isKnown,
      source: isKnown ? sourceWhenKnown : unknownSource,
      reason: isKnown ? reasonWhenKnown : unknownReason,
    }]
  })) as ResolvedMachineMotion['datum']['axes']
  const allKnown = AXES.every(({ key }) => axes[key].known)
  return {
    known: allKnown,
    source: allKnown ? sourceWhenKnown : unknownSource,
    reason: allKnown ? reasonWhenKnown : unknownReason,
    axes,
  }
}

export function resolveMachineMotion(input: ResolveMachineMotionInput): ResolvedMachineMotion {
  const { machine, connectionKind, settings = {}, datumKnown = false } = input
  const authority: ResolvedMachineMotion['authority'] = connectionKind === 'simulator'
    ? 'simulator-profile'
    : connectionKind === 'serial'
      ? 'live-grbl'
      : connectionKind === 'bridge'
        ? 'live-uccnc'
        : 'configured-profile'
  // WO-1701 (ADR-0049): the home end is the record's one fact - the
  // definition's homing.perAxis for every axis whose homing it STATES, the
  // CAM lens's own statement otherwise (a placeholder homing block is not a
  // statement). Never a separately-kept convention.
  const declaredConvention = machineHomeConvention(machine)
  const declared = declaredConvention
    ? deriveMachineEnvelopeFromConvention(declaredConvention, machineTravel(machine))
    : { x: null, y: null, z: null }
  const reportedEnvelope = deriveMachineEnvelope(settings, {
    noHomingSwitches: machine.noHomingSwitches,
  })
  const liveGrbl = connectionKind === 'serial'
    ? reportedEnvelope
    : { x: null, y: null, z: null }
  const diagnostics: string[] = []

  const resolved = Object.fromEntries(AXES.map(({ key, label }) => {
    const live = liveGrbl[key]
    const configuredState = definitionState(machine, label)
    const profile = profileRange(declared, key, machine)
    const physical: ResolvedMotionRange | null = connectionKind === 'serial'
      ? live
        ? {
            min: live.min,
            max: live.max,
            source: 'live-grbl-settings',
            reason: `live GRBL $${key === 'x' ? 130 : key === 'y' ? 131 : 132}/$23/$27 readback`,
          }
        : null
      : live
      ? {
          min: live.min,
          max: live.max,
          source: 'live-grbl-settings',
          reason: `live GRBL $${key === 'x' ? 130 : key === 'y' ? 131 : 132}/$23/$27 readback`,
        }
      : profile
    const controller = connectionKind === 'bridge'
      || connectionKind === 'simulator'
      || connectionKind === null
      ? controllerRange(machine, connectionKind, label, configuredState)
      : null
    const intersection = intersectRanges(physical, controller)
    const invalid = configuredState === 'invalid'
    const unavailable = configuredState === 'disabled' || configuredState === 'undefined'
    const state: ResolvedMachineAxisMotion['state'] = invalid
      ? 'invalid'
      : unavailable
        ? 'unknown'
        : intersection.conflict
          ? 'conflict'
          : intersection.range
            ? 'bounded'
            : 'unknown'
    const reason = invalid
      ? `${label} controller soft limits contradict themselves`
      : unavailable
        ? configuredState === 'disabled'
          ? `${label} is disabled in the controller definition`
          : `${label} is omitted from the controller definition`
      : intersection.conflict
        ? `${physical!.reason} ${label} range ${physical!.min}..${physical!.max} and ${controller!.reason} ${label} range ${controller!.min}..${controller!.max} have no usable intersection`
        : intersection.range?.reason ?? `${label} travel is not stated`
    if (state === 'invalid' || state === 'conflict') diagnostics.push(reason)
    const axisLimits = machine.axisLimits?.[key]
    const definitionAxis = machine.controllerDefinition?.axes.find((candidate) => candidate.axis === label)
    // WO-1700 (ADR-0049; Operator 2026-09-19): once a definition states axis
    // speeds, each axis rapids at min(its own max velocity, the machine's
    // effective everyday rapid); an axis stating no speed uses the effective
    // rapid. The Machine Library's axisLimits copies are not consulted. With
    // no definition speeds, axisLimits/rapidRate remain the complete answer.
    const rapidFact = machineRapidRate(machine)
    const rapidMmMin = rapidFact && rapidFact.ceiling !== null
      ? positive(definitionAxis?.maxVelocity)
        ? Math.min(definitionAxis.maxVelocity, rapidFact.mmMin)
        : rapidFact.mmMin
      : positive(axisLimits?.maxRapid)
        ? axisLimits.maxRapid
        : positive(machine.rapidRate)
          ? machine.rapidRate
          : null
    const zero = declaredConvention?.[key]
    return [key, {
      axis: label,
      physical,
      controller,
      effective: invalid || unavailable || intersection.conflict ? null : intersection.range,
      definitionState: configuredState,
      state,
      reason,
      homesToward: zero?.homesToward ?? live?.homesToward ?? null,
      machineZeroAt: zero?.machineZeroAt ?? (zero?.homePositionMm !== undefined ? 'legacy-position' : null),
      rapidMmMin,
      maxVelocityMmMin: positive(definitionAxis?.maxVelocity) ? definitionAxis.maxVelocity : null,
    } satisfies ResolvedMachineAxisMotion]
  })) as Record<EnvelopeAxisId, ResolvedMachineAxisMotion>

  const envelope: MachineEnvelope = {
    x: rangeEnvelope(resolved.x.effective, declaredConvention?.x),
    y: rangeEnvelope(resolved.y.effective, declaredConvention?.y),
    z: rangeEnvelope(resolved.z.effective, declaredConvention?.z),
  }
  const rapidCandidates = AXES.map(({ key }) => resolved[key].rapidMmMin).filter(positive)
  return {
    authority,
    machineId: machine.id,
    machineName: machine.name,
    axes: resolved,
    envelope,
    reportedEnvelope,
    datum: datum(machine, connectionKind, datumKnown),
    rapidMmMin: rapidCandidates.length > 0 ? Math.min(...rapidCandidates) : null,
    diagnostics,
  }
}
