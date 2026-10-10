// toolTable - sender-side tool length table (MACHINE-CONTROL stage 10).
//
// GRBL has no controller-side tool table, so LienCAM keeps one per MACHINE:
// each tool's probed machine Z on the fixed pad, with ONE tool starred as the
// REFERENCE (the tool that was active when work Z0 was set). Applying a tool
// sends G43.1 with the length DIFFERENCE to the reference; G49 clears it.
//
// Pure module: types, defaults, reference math, config validation.
// Persistence lives in machineToolTableStore; sequencing in machineSession.

import type { MachineConfig, MachineProbeDefaults } from '../../types'

export interface ToolTableEntry {
  /** T number (>= 0, integer). */
  tool: number
  /** Machine Z at pad contact from the slow probe pass; null = not measured. */
  probedMachineZ: number | null
  /** Tool diameter, mm - informational, shown next to the number. */
  dia: number | null
  note: string
  /** Epoch ms of the last successful measurement; null = never. */
  measuredAt: number | null
}

export interface MachineToolTable {
  /** T number of the reference tool (work Z0 was set with it); null = none. */
  reference: number | null
  tools: ToolTableEntry[]
}

/** One operator-saved removable part pad. The selected choice is the source
 * of the effective part-probe thickness; fixed tool setters do not use it. */
export interface ProbePadChoice {
  id: string
  thickness: number
}

export const EMPTY_TOOL_TABLE: MachineToolTable = { reference: null, tools: [] }

/** Fixed-pad Z probe cycle configuration (per machine, mm / mm-per-min). */
export interface ZProbeConfig {
  fastFeed: number
  slowFeed: number
  /** Feed for operator-confirmed clear positioning between feature touches. */
  positioningFeed?: number
  /** Pull-off between the fast and slow passes, and after the cycle. */
  retract: number
  /** Maximum downward search distance for the fast pass. */
  maxTravel: number
  /** Distance kept between an approach point and the expected surface. */
  surfaceClearance?: number
  /** Additional bounded search beyond the expected surface. */
  overtravel?: number
  /** Z lift used before crossing over an outside boss or web. */
  crossOverLift?: number
  /** Pad thickness - work Z0 is set this far below the contact point. */
  padThickness: number
}

export const DEFAULT_MACHINE_PROBE_DEFAULTS: MachineProbeDefaults = {
  positioningFeed: 1000,
  fastFeed: 400,
  slowFeed: 50,
  retract: 2,
  maxTravel: 50,
  surfaceClearance: 5,
  overtravel: 5,
  crossOverLift: 10,
  padThickness: 10,
}

export const DEFAULT_ZPROBE_CONFIG: ZProbeConfig = { ...DEFAULT_MACHINE_PROBE_DEFAULTS }

export type EffectiveProbeConfig = Required<ZProbeConfig>

/** Legacy profiles/config records omit WO-372 fields. Resolve every layer to
 *  one complete motion contract before validation or command generation. */
export function resolveProbeConfig(
  machineDefaults?: Partial<MachineProbeDefaults> | null,
  override?: Partial<ZProbeConfig> | null,
): EffectiveProbeConfig {
  return {
    ...DEFAULT_MACHINE_PROBE_DEFAULTS,
    ...(machineDefaults ?? {}),
    ...(override ?? {}),
  }
}

export function newToolEntry(tool: number): ToolTableEntry {
  return { tool, probedMachineZ: null, dia: null, note: '', measuredAt: null }
}

export function findTool(table: MachineToolTable, tool: number): ToolTableEntry | undefined {
  return table.tools.find((t) => t.tool === tool)
}

/** THIS MACHINE'S TOOL TABLE (WO-1676): the definition's own `toolTable`,
 *  never a second source. Absent means no rows yet. */
export function machineToolTable(
  machine: Pick<MachineConfig, 'toolTable'> | null | undefined,
): MachineToolTable {
  return machine?.toolTable ?? EMPTY_TOOL_TABLE
}

/** THIS MACHINE'S PROBE OVERRIDE (WO-1676): the definition's own
 *  `probeOverrides`, layered over `probing` by `resolveProbeConfig` exactly
 *  as before - only the storage moved. */
export function machineProbeOverride(
  machine: Pick<MachineConfig, 'probeOverrides' | 'probePads' | 'activeProbePadId'> | null | undefined,
): Partial<ZProbeConfig> | undefined {
  if (!machine) return undefined
  const activePad = machine.probePads?.find((pad) => pad.id === machine.activeProbePadId)
  return activePad
    ? { ...(machine.probeOverrides ?? {}), padThickness: activePad.thickness }
    : machine.probeOverrides
}

/**
 * The G43.1 line that makes `tool` cut at the depths the REFERENCE tool was
 * zeroed for: TLO = probedZ(tool) - probedZ(reference). Fails loudly when
 * either measurement is missing - never guesses a length.
 */
export function toolOffsetLine(
  table: MachineToolTable,
  tool: number,
):
  | { ok: true; line: string; deltaMm: number }
  | { ok: false; reason: string } {
  if (table.reference === null) {
    return { ok: false, reason: 'No reference tool is set - star the tool that was active when work Z0 was set.' }
  }
  const ref = findTool(table, table.reference)
  if (!ref || ref.probedMachineZ === null) {
    return { ok: false, reason: `Reference tool T${table.reference} has no probed length yet.` }
  }
  const entry = findTool(table, tool)
  if (!entry || entry.probedMachineZ === null) {
    return { ok: false, reason: `T${tool} has no probed length yet - measure it on the pad first.` }
  }
  const deltaMm = entry.probedMachineZ - ref.probedMachineZ
  return { ok: true, line: `G43.1 Z${Number(deltaMm.toFixed(4))}`, deltaMm }
}

/** Plain-language validation of probe settings before any motion happens. */
export function validateZProbeConfig(config: ZProbeConfig): { ok: true } | { ok: false; reason: string } {
  const effective = resolveProbeConfig(null, config)
  const finite = [
    effective.positioningFeed,
    effective.fastFeed,
    effective.slowFeed,
    effective.retract,
    effective.maxTravel,
    effective.surfaceClearance,
    effective.overtravel,
    effective.crossOverLift,
    effective.padThickness,
  ]
  if (finite.some((v) => !Number.isFinite(v))) {
    return { ok: false, reason: 'Probe settings must all be numbers.' }
  }
  if (effective.positioningFeed <= 0 || effective.fastFeed <= 0 || effective.slowFeed <= 0) {
    return { ok: false, reason: 'Probe feeds must be greater than zero.' }
  }
  if (effective.slowFeed > effective.fastFeed) {
    return { ok: false, reason: 'The fine pass should be slower than the fast pass.' }
  }
  if (effective.retract <= 0) return { ok: false, reason: 'Retract must be greater than zero.' }
  if (effective.maxTravel <= effective.retract) {
    return { ok: false, reason: 'Max travel must be larger than the retract distance.' }
  }
  if (effective.surfaceClearance <= 0) {
    return { ok: false, reason: 'Surface clearance must be greater than zero.' }
  }
  if (effective.overtravel <= 0) return { ok: false, reason: 'Overtravel must be greater than zero.' }
  // Feature-aware planners compare clearance + overtravel with maxTravel.
  // Keep this base validator compatible with legacy fixed-pad records whose
  // smaller maxTravel predates those feature-only settings.
  if (effective.crossOverLift <= 0) {
    return { ok: false, reason: 'Cross-over lift must be greater than zero.' }
  }
  if (effective.padThickness < 0) return { ok: false, reason: 'Pad thickness cannot be negative.' }
  return { ok: true }
}
