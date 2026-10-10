// machineActions - the action ABSTRACTION LAYER (MACHINE-CONTROL stage 9).
//
// Operator's ruling 2026-07-31: machines are wired differently (vacuum, coolant,
// spindle may use non-standard codes; controller flavors differ), so no
// Control-tab button hardcodes what it sends. Every action resolves:
//   user override (per machine)  ->  controller-flavor default
// and users can define CUSTOM buttons on the same mechanism. Smart defaults,
// never locked in.
//
// Pure module: types, per-controller default tables, {rpm} substitution,
// and line validation. Persistence lives in machineActionsStore; execution
// in machineSession.runMachineAction.

import { machineParks, machineSafeZ, parsePositionMacroBody, type ControllerType, type MachineConfig } from '../../types'
import { SHARED_OFF_CODE, machineOutputWithRole, type OutputMachine } from './machineOutputs'

export type BuiltinActionId =
  | 'spindleCw'
  | 'spindleCcw'
  | 'spindleOff'
  | 'coolantMist'
  | 'coolantFlood'
  | 'coolantOff'

/** The color-contract palette for custom buttons (WO-1707: and macros, the
 *  same buttons now). */
export type ActionColor = 'green' | 'amber' | 'red' | 'cyan' | 'neutral'

/** The color picker's own labels - one table, so a picker never drifts from
 *  the contract above. Used by the macro editor (WO-1707); the retired
 *  custom-button editor had its own copy. */
export const ACTION_COLORS: Array<{ id: ActionColor; label: string }> = [
  { id: 'green', label: 'Go / motion' },
  { id: 'amber', label: 'Caution' },
  { id: 'red', label: 'Stop / off' },
  { id: 'cyan', label: 'Aux' },
  { id: 'neutral', label: 'Neutral' },
]

export interface CustomAction {
  id: string
  label: string
  color: ActionColor
  /** Command lines, sent in order down the MDI path. May use {rpm}. */
  lines: string[]
  /** Two-press arming before firing (for consequential outputs). */
  confirm?: boolean
}

/** A park the session can move to - MACHINE coordinates (mm). A position
 *  macro on the machine definition is one (WO-1681: `parkMacroPositions`
 *  reads the macro list); absent that, `machineParks` offers the G30 points.
 *  `z` is where the Z leg goes; absent, the move uses the machine's safe Z.
 *  `zFirst` absent means Z first. */
export interface ParkPosition {
  id: string
  label: string
  x: number
  y: number
  z?: number | null
  zFirst?: boolean
}

export interface MachineActionConfig {
  /** BuiltinActionId -> replacement lines. Absent = controller default. */
  overrides: Partial<Record<BuiltinActionId, string[]>>
  custom: CustomAction[]
  /** Parks stored with the wiring before WO-1670. A position macro on the
   *  definition is the source, then its G30 points (`machineParks`); these
   *  are read only by `machineParkList` when the definition states neither. */
  parks?: ParkPosition[]
  /** Pre-1681 wiring-store designation of which park the guided tool change
   *  used. No longer written (there is no setter - the Macros panel's
   *  `usedForToolChange` flag, WO-1681 fix round, is the one source now) and
   *  no longer read here - kept only so `convertParksToMacros` (types/
   *  index.ts) can bake a still-persisted value onto the macro it becomes,
   *  once, at load (`store/index.ts`'s `adoptMachineDocument`). */
  toolChangeParkId?: string | null
}

type ParkMachine = Pick<MachineConfig, 'referencePositions' | 'controllerDefinition' | 'safeZMachine' | 'macros'>

/** Every position macro this machine has, in the user's macro order
 *  (WO-1681: a park is a macro whose body is the built-in "go to machine
 *  position" step - `parsePositionMacroBody` recognises it). */
export function parkMacroPositions(machine: Pick<MachineConfig, 'macros'> | null | undefined): ParkPosition[] {
  return (machine?.macros ?? []).flatMap((macro) => {
    const fields = parsePositionMacroBody(macro.body)
    return fields ? [{ id: macro.id, label: macro.name, x: fields.x, y: fields.y, z: fields.z, zFirst: fields.zFirst }] : []
  })
}

/** EVERY PARK THIS MACHINE HAS: its position macros (WO-1681), else its G30
 *  points, and only when it states neither, the list stored with the wiring.
 *  One answer every macro button, M-code and tool change reads. */
export function machineParkList(
  machine: ParkMachine | null | undefined,
  config: MachineActionConfig | undefined,
): ParkPosition[] {
  const macroParks = parkMacroPositions(machine)
  if (macroParks.length > 0) return macroParks
  const defined = machineParks(machine)
  return defined.length > 0 ? defined : (config?.parks ?? [])
}

/** THIS MACHINE'S SAFE Z (machine mm): the definition's - a UCCNC profile's
 *  `Generalsettings.SafeZ`, or typed on the definition (WO-1702: one field;
 *  the wiring-store's `config.safeZMachine` is never read here any more -
 *  nothing has set it since WO-1670 moved Safe Z onto the definition, so it
 *  could only ever answer with a stale value). Null = nobody said.
 *  `config` stays a parameter so every existing caller is unaffected. */
export function machineSafeZValue(
  machine: ParkMachine | null | undefined,
  _config?: MachineActionConfig,
): number | null {
  return machineSafeZ(machine)?.z ?? null
}

/** The park a macro flagged `usedForToolChange` resolves to (WO-1681 fix
 *  round: a property of the macro itself, on the one macro model - not a
 *  separate designation table). Null when no macro carries the flag. */
export function toolChangeMacroPark(
  machine: Pick<MachineConfig, 'macros'> | null | undefined,
  parks: readonly ParkPosition[],
): ParkPosition | null {
  const flagged = (machine?.macros ?? []).find((m) => m.usedForToolChange)
  if (!flagged) return null
  return parks.find((p) => p.id === flagged.id) ?? null
}

/** The park the guided tool change (and M2001's clamp pause) drives to: the
 *  macro flagged for it (WO-1681 fix round - the one source; the pre-1681
 *  wiring-store `toolChangeParkId` fallback is gone, WO-1681 fix round 2),
 *  else the only park when exactly one exists. Null = the operator must
 *  designate. */
export function toolChangePark(
  machine: Pick<MachineConfig, 'macros'> | null | undefined,
  config: MachineActionConfig | undefined,
  parks: readonly ParkPosition[] = config?.parks ?? [],
): ParkPosition | null {
  const macroPark = toolChangeMacroPark(machine, parks)
  if (macroPark) return macroPark
  return parks.length === 1 ? parks[0] : null
}

export const EMPTY_ACTION_CONFIG: MachineActionConfig = {
  overrides: {},
  custom: [],
  parks: [],
}

/**
 * The command sequence for a park move, both legs G53: Z to the park's own
 * machine Z (the machine's safe Z when the park states none) and X Y to the
 * park - Z first unless the park says otherwise. The one thing it cannot do
 * is move Z to a height nobody stated; that is the only refusal.
 */
export function buildParkSequence(
  park: ParkPosition,
  safeZMachine: number | null | undefined,
): { ok: true; lines: string[] } | { ok: false; reason: string } {
  const z = typeof park.z === 'number' && Number.isFinite(park.z) ? park.z : safeZMachine
  if (z === null || z === undefined || !Number.isFinite(z)) {
    return {
      ok: false,
      reason: `Park "${park.label}" states no Z and this machine has no safe Z, so there is no height to move Z to.`,
    }
  }
  if (!Number.isFinite(park.x) || !Number.isFinite(park.y)) {
    return { ok: false, reason: `Park "${park.label}" has no valid position stored.` }
  }
  // Safe Z and the park XY are millimetres, so each line says G21: with no
  // units word an inch session reads them 25.4x too far (WO-1548). The sender
  // puts the operator's units and distance mode back afterwards.
  const zLine = `G21 G90 G53 G0 Z${Number(z.toFixed(3))}`
  const xyLine = `G21 G90 G53 G0 X${Number(park.x.toFixed(3))} Y${Number(park.y.toFixed(3))}`
  return { ok: true, lines: park.zFirst === false ? [xyLine, zLine] : [zLine, xyLine] }
}

export function newParkId(): string {
  return `park_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
}

export const BUILTIN_ACTION_LABELS: Record<BuiltinActionId, string> = {
  spindleCw: 'Spindle CW',
  spindleCcw: 'Spindle CCW',
  spindleOff: 'Spindle stop',
  coolantMist: 'Coolant mist',
  coolantFlood: 'Coolant flood',
  coolantOff: 'Coolant off',
}

/**
 * Controller-neutral stops used only when controller identity is undeclared.
 * Every supported controller uses these same standard stop words. Keeping them
 * separate from the controller default table preserves the invariant that no
 * identity gate may block a stop without choosing a default controller.
 */
export const CONTROLLER_NEUTRAL_STOP_LINES: Record<
  Extract<BuiltinActionId, 'spindleOff' | 'coolantOff'>,
  string[]
> = {
  spindleOff: ['M5'],
  coolantOff: ['M9'],
}

/**
 * THE STANDARD WORDS, ONE TABLE (WO-1649).
 *
 * This used to be five per-controller records - grbl, grblhal, linuxcnc, uccnc,
 * generic - holding the SAME six lines, on the theory that flavor belongs here.
 * It does not, and the five copies proved it: they never once disagreed, and
 * what actually differs between two machines is which PIN a word switches and
 * which word the operator chose, both of which live in the machine definition's
 * one output list. So the standard words are stated once, and a machine that
 * uses different ones says so in its list (`builtinDefaultLines`).
 *
 * `controller` stays in the signature because the caller genuinely has a
 * controller and a future dialect that spells a stop differently would be read
 * here - not because these six lines currently vary by one.
 */
const STANDARD_ACTION_LINES: Record<BuiltinActionId, string[]> = {
  spindleCw: ['M3 S{rpm}'],
  spindleCcw: ['M4 S{rpm}'],
  spindleOff: ['M5'],
  coolantMist: ['M7'],
  coolantFlood: ['M8'],
  coolantOff: ['M9'],
}

/** Which output role each coolant action switches. The spindle actions have no
 *  role: they are the spindle call, and any relay beside it is switched by the
 *  session from the same list. */
const ACTION_ROLE = {
  coolantMist: 'mist',
  coolantFlood: 'flood',
} as const

/**
 * The lines this action sends on this machine when the operator has not
 * overridden it.
 *
 * WO-1649: THE MACHINE'S OWN LIST IS ASKED FIRST. A machine whose mist is
 * listed on M107 gets M107 from the Mist button, the same word a file's own
 * coolant line is answered with, without anybody typing an override - that is
 * what "they point them at the use cases" means for a button. `machine` is
 * optional so a caller that legitimately has no machine (the editor showing
 * what a controller's default IS) still gets the standard answer.
 */
export function builtinDefaultLines(
  controller: ControllerType,
  action: BuiltinActionId,
  machine?: OutputMachine | null,
): string[] {
  void controller
  if (action === 'coolantOff') {
    return machineOutputWithRole(machine, 'mist') !== null
      || machineOutputWithRole(machine, 'flood') !== null
      ? [SHARED_OFF_CODE]
      : STANDARD_ACTION_LINES.coolantOff
  }
  const role = action === 'coolantMist' || action === 'coolantFlood' ? ACTION_ROLE[action] : null
  if (role !== null) {
    const listed = machineOutputWithRole(machine, role)
    if (listed !== null) return [listed.onCode]
  }
  return STANDARD_ACTION_LINES[action]
}

/** THIS MACHINE'S M-CODE OVERRIDES (WO-1676): the definition's own
 *  `actionOverrides`, never a second source. Absent for an action means it
 *  sends its controller/output default. */
export function machineActionOverride(
  machine: { actionOverrides?: Partial<Record<BuiltinActionId, string[]>> } | null | undefined,
): Partial<Record<BuiltinActionId, string[]>> | undefined {
  return machine?.actionOverrides
}

/** Resolve the effective lines for a built-in action: override or default. */
export function resolveBuiltinLines(
  config: MachineActionConfig | undefined,
  controller: ControllerType,
  action: BuiltinActionId,
  machine?: OutputMachine | null,
): string[] {
  const override = config?.overrides[action]
  return override && override.length > 0 ? override : builtinDefaultLines(controller, action, machine)
}

/** Substitute placeholders. {rpm} is the only template variable (deliberate). */
export function substituteActionLines(lines: string[], ctx: { rpm: number }): string[] {
  const rpm = Math.max(0, Math.round(ctx.rpm))
  return lines.map((l) => l.replaceAll('{rpm}', String(rpm)))
}

const MAX_ACTION_LINES = 20
const MAX_LINE_CHARS = 80 // GRBL line buffer

/**
 * Validate user-entered action lines. Returns cleaned lines or a plain
 * reason. Never silently drops content the user typed.
 */
export function validateActionLines(raw: string): { ok: true; lines: string[] } | { ok: false; reason: string } {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
  if (lines.length === 0) return { ok: false, reason: 'Enter at least one command line.' }
  if (lines.length > MAX_ACTION_LINES) {
    return { ok: false, reason: `Too many lines (${lines.length}) - actions are capped at ${MAX_ACTION_LINES}.` }
  }
  for (const l of lines) {
    if (l.length > MAX_LINE_CHARS) {
      return { ok: false, reason: `"${l.slice(0, 24)}..." is over GRBL's ${MAX_LINE_CHARS}-character line limit.` }
    }
    // Control characters would be swallowed or misread by the controller.
    if (l.split('').some((ch) => ch.charCodeAt(0) <= 0x1f || ch.charCodeAt(0) === 0x7f)) {
      return { ok: false, reason: 'Command lines cannot contain control characters.' }
    }
  }
  return { ok: true, lines }
}

export function validateActionLabel(label: string): { ok: true; label: string } | { ok: false; reason: string } {
  const trimmed = label.trim()
  if (trimmed === '') return { ok: false, reason: 'The button needs a label.' }
  if (trimmed.length > 18) return { ok: false, reason: 'Keep labels under 18 characters so buttons stay readable.' }
  return { ok: true, label: trimmed }
}

export function newCustomActionId(): string {
  return `act_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
}
