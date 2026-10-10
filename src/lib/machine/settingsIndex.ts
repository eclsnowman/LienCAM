/**
 * ONE LIST OF EVERY SETTING THE MACHINE'S CONTROLLER SURFACE OFFERS (WO-1685).
 *
 * The All-settings table (WO-1689) and its search box read this and nothing
 * else. It reads the two existing catalogues behind one shape - UCCNC's
 * `UCCNC_SETTING_FIELDS` (`uccncProfileImport.ts`) and GRBL's `GRBL_SETTINGS`
 * (`grbl/settings.ts`) - and never learns either vocabulary itself.
 *
 * UCCNC AND GRBL ARE INDEXED DIFFERENTLY, ON PURPOSE. UCCNC's catalogue is
 * the whole, fixed vocabulary UCCNC documents, so every machine gets all
 * 1681 rows whether or not it has stated each one - the same reasoning
 * `ControllerSettingField` already gives for offering a from-scratch
 * definition every key. GRBL has no such fixed vocabulary: a board's actual
 * `$`-settings vary by firmware and build, `GRBL_SETTINGS` only names the
 * common ones, and refusing to list an id it does not recognise would be
 * exactly the invention rule 11 forbids. So a GRBL machine is indexed from
 * what it actually stated (`MachineConfig.grblSettings`), catalogued ids
 * getting their own name and unit and uncatalogued ones falling back to
 * their `$id`.
 *
 * `ownedBy` NAMES A CARD, NOT A FIELD PATH. `ControllerSettingField.ownedBy`
 * (when set at all - only the e-stop and probe wiring keys carry one) points
 * at the `ControllerDefinition` field that already holds the value. This
 * module's `ownedBy` is a different, coarser fact for the plan's tabs:
 * which of Overview / Machine / Spindle / Outputs & coolant / Probing /
 * Controller shows this setting, or none when it only ever appears here.
 * Resolved from the catalogue's own section (`group`), with the three
 * per-key wiring exceptions v2/SLICES.md T10 and T11 call out by name.
 */
import {
  type AxisName,
  type ControllerDefinition,
  type ControllerSetting,
  type ControllerSettingField,
  type ControllerType,
  type MachineConfig,
  type MachineKind,
  controllerSettingValue,
  machineKind,
} from '../../types'
import {
  UCCNC_SETTING_FIELDS,
  formatUccncSettingValue,
} from './uccncProfileImport'
import {
  GRBL_SETTINGS,
  formatGrblMask,
  isGrblMachine,
  type GrblSettingsRecord,
} from './grbl/settings'

/** The plan's tabs that a setting can be shown on (v2/SLICES.md T4). `null`
 *  means the setting appears in All settings only. */
export type SettingsIndexCard =
  | 'Overview' | 'Machine' | 'Spindle' | 'Outputs & coolant' | 'Probing' | 'Controller'

/** One setting, on whichever controller states it, behind one shape. */
export interface SettingsIndexRow {
  controller: ControllerType
  /** The controller's own key, unabbreviated - `Spindlesetupsettings.M9delay`,
   *  `$130` - so a writer can find the setting this row describes. */
  key: string
  /** The catalogue's own section, in plain words - "Axis X", "Spindle",
   *  "Inputs and outputs" - never the raw section key. */
  group: string
  /** The setting's own name within its group. */
  name: string
  kind: string
  unit: string
  meaning: string
  /** This machine's stated value, formatted for display, or null when the
   *  machine has not stated one. */
  value: string | null
  ownedBy: SettingsIndexCard | null
  /** Whether this row applies to the machine it was built from - false for a
   *  plasma/laser/knife-only setting on a machine of a different kind, or a
   *  rotary-profile setting for an axis this machine has not enabled
   *  (WO-1695, COHESION-STANDARD s18). The row and its stored `value` are
   *  built and kept either way - hidden is not deleted - so a renderer must
   *  read `visible` itself rather than expect it filtered out here. */
  visible: boolean
}

interface GroupInfo {
  label: string
  card: SettingsIndexCard | null
}

const AXIS_GROUP_INFO: Record<string, GroupInfo> = {
  axessettingscontrolX: { label: 'Axis X', card: 'Machine' },
  axessettingscontrolY: { label: 'Axis Y', card: 'Machine' },
  axessettingscontrolZ: { label: 'Axis Z', card: 'Machine' },
  axessettingscontrolA: { label: 'Axis A', card: 'Machine' },
  axessettingscontrolB: { label: 'Axis B', card: 'Machine' },
  axessettingscontrolC: { label: 'Axis C', card: 'Machine' },
}

/** Every other UCCNC section `UCCNC_SETTING_FIELDS` groups its keys under,
 *  named in plain words. `card: null` sections show in All settings only -
 *  decided from v2/SLICES.md's Wave 2 areas (T7-T11): a section only gets a
 *  card when an area's own text names it as that area's source. */
const SECTION_GROUP_INFO: Record<string, GroupInfo> = {
  ...AXIS_GROUP_INFO,
  Spindlesetupsettings: { label: 'Spindle', card: 'Spindle' },
  SpindlePIDsettings: { label: 'Spindle PID', card: 'Spindle' },
  // T11: "trajectory basics (constant velocity, lookahead)" on the
  // Controller area are Generalsettings keys.
  Generalsettings: { label: 'General', card: 'Controller' },
  IOsetupsettings: { label: 'Inputs and outputs', card: null },
  AUXencodersettings: { label: 'Auxiliary encoders', card: null },
  Digitizesettings: { label: 'Digitizing', card: null },
  // T10: the Probing area reads io.probe/io.probe2 and MachineProbeDefaults,
  // not this catalogue section - UCCNC's `Probing.*` stays in All settings.
  Probing: { label: 'Probing', card: null },
  // T11: the Controller area shows a faults COUNT, linking into All settings
  // rather than owning these rows.
  FaultSignals: { label: 'Fault signals', card: null },
  ModbusEZ: { label: 'Modbus EZ', card: null },
  Modbus_connection_0: { label: 'Modbus connection', card: null },
  Modbus_function_0_0: { label: 'Modbus function 1', card: null },
  Modbus_function_0_1: { label: 'Modbus function 2', card: null },
  Modbus_function_0_2: { label: 'Modbus function 3', card: null },
  Modbus_function_0_3: { label: 'Modbus function 4', card: null },
  Inputtriggersettings: { label: 'Input triggers', card: null },
  Outputtriggersettings: { label: 'Output triggers', card: null },
  Macroloops: { label: 'Macro loops', card: null },
  Laserengraveplugin: { label: 'Laser engraving', card: null },
  RFHsettings: { label: 'Rigid tapping', card: null },
}

/** T11 names the e-stop pin on the Controller area; T10 names io.probe and
 *  io.probe2 on the Probing area. Both are `IOsetupsettings` keys that would
 *  otherwise fall to `card: null` with the rest of that mixed section. */
const IO_KEY_CARD_OVERRIDE: Record<string, SettingsIndexCard> = {
  Estopportnumber: 'Controller',
  Estoppinnumber: 'Controller',
  Estoppinnegate: 'Controller',
  Probeportnumber: 'Probing',
  Probepinnumber: 'Probing',
  Probepinnegate: 'Probing',
  Probeport2number: 'Probing',
  Probepin2number: 'Probing',
  Probepin2negate: 'Probing',
}

const uccncFieldName = (field: ControllerSettingField): string =>
  field.key.slice(field.group.length + 1)

const AXIS_GROUP_PATTERN = /^axessettingscontrol([A-Z])$/

/** Whether a UCCNC catalogue row applies to this machine (WO-1695,
 *  COHESION-STANDARD s18: "a few machine type filters at the top"). Read
 *  `machine.kind` alone for the plasma/laser/knife-only rows the standard
 *  names; a rotary-profile row is a separate, axis-enabled fact UCCNC gives
 *  only to A, B and C, never a per-field guess. Everything else is on for
 *  every kind. */
function rowVisible(
  field: ControllerSettingField,
  name: string,
  kind: MachineKind,
  controllerDefinition: ControllerDefinition | undefined,
): boolean {
  // THC-prefixed names live in IOsetupsettings; DebounceTHC (its input
  // debounce) is the one torch-height-control key UCCNC filed under
  // Generalsettings instead - still plasma-only.
  if (name.startsWith('THC') || name === 'DebounceTHC' || name === 'Plasmapierceheight') {
    return kind === 'plasma'
  }
  if (name.startsWith('Laseroutput') || name === 'Chargepumplasermodeon'
    || field.group === 'Laserengraveplugin') return kind === 'laser'
  if (name.startsWith('Dragknife')) return kind === 'knife'
  if (name === 'Rotaryaxis' || name === 'Rotaryrollover') {
    const axis = AXIS_GROUP_PATTERN.exec(field.group)?.[1] as AxisName | undefined
    if (!axis) return true
    return controllerDefinition?.axes.some((a) => a.axis === axis && a.enabled) ?? false
  }
  return true
}

const uccncOwner = (field: ControllerSettingField, name: string): SettingsIndexCard | null => {
  if (field.group === 'IOsetupsettings') {
    const override = IO_KEY_CARD_OVERRIDE[name]
    if (override) return override
  }
  return SECTION_GROUP_INFO[field.group]?.card ?? null
}

function uccncRows(
  settings: readonly ControllerSetting[] | undefined,
  kind: MachineKind,
  controllerDefinition: ControllerDefinition | undefined,
): SettingsIndexRow[] {
  return UCCNC_SETTING_FIELDS.map((field) => {
    const name = uccncFieldName(field)
    const value = controllerSettingValue(settings, 'uccnc', field.key)
    return {
      controller: 'uccnc',
      key: field.key,
      group: SECTION_GROUP_INFO[field.group]?.label ?? field.group,
      name,
      kind: field.kind,
      unit: field.unit,
      meaning: field.meaning,
      value: value ? formatUccncSettingValue(value) : null,
      ownedBy: uccncOwner(field, name),
      visible: rowVisible(field, name, kind, controllerDefinition),
    }
  })
}

const GRBL_GROUP = 'GRBL settings'

function grblRows(stated: GrblSettingsRecord | undefined): SettingsIndexRow[] {
  const ids = Object.keys(stated ?? {})
    .map((idText) => Number(idText))
    .filter((id) => Number.isSafeInteger(id))
    .sort((a, b) => a - b)
  return ids.map((id) => {
    const definition = GRBL_SETTINGS[id]
    const raw = (stated as GrblSettingsRecord)[id]
    const value = definition?.kind === 'mask' && definition.maskBits
      ? formatGrblMask(raw, definition.maskBits)
      : raw
    const name = definition?.name ?? `$${id}`
    return {
      controller: 'grbl',
      key: `$${id}`,
      group: GRBL_GROUP,
      name,
      kind: definition?.kind ?? 'number',
      unit: definition?.unit ?? 'none',
      meaning: name,
      value: value ?? null,
      ownedBy: null,
      // GRBL has no plasma/laser/knife-only settings this software indexes
      // yet ($32 "Laser mode" is a mode flag, not a plasma/laser/knife-only
      // control surface the way THC or drag-knife are) - always visible.
      visible: true,
    }
  })
}

/** WO-1731: the app-owned statement vocabulary. A `liencam.*` key belongs to
 *  no controller's catalogue, so no catalogue indexes it - but it IS a
 *  setting this machine stated, in its own controller's container, and any
 *  controller's machine can state one. These rows come off the definition
 *  itself, with no controller branch. */
const LIENCAM_KEY_PREFIX = 'liencam.'

/** The rows for what the DEFINITION states that the controller catalogues
 *  above did not already name: LienCAM's own keys, under this machine's
 *  controller. A UCCNC or GRBL machine states none of these today (its
 *  profile/settings keys are catalogue or `$`-id vocabulary, already
 *  indexed), so this adds nothing to what those machines draw; a hand-built
 *  machine states safe Z, back-off and home input this way, and its rows
 *  appear exactly the same. */
function liencamRows(
  machine: Pick<MachineConfig, 'controller' | 'controllerDefinition'>,
  indexed: readonly SettingsIndexRow[],
): SettingsIndexRow[] {
  const seen = new Set(indexed.map((row) => `${row.controller}:${row.key.toLowerCase()}`))
  const entries = (machine.controllerDefinition?.settings ?? [])
    .filter((entry) => entry.controller === machine.controller
      && entry.key.startsWith(LIENCAM_KEY_PREFIX)
      && !seen.has(`${entry.controller}:${entry.key.toLowerCase()}`))
  return entries.map((entry) => ({
    controller: entry.controller,
    key: entry.key,
    group: 'LienCAM',
    name: entry.key.slice(LIENCAM_KEY_PREFIX.length),
    kind: entry.value.kind,
    unit: entry.value.kind === 'number' ? 'mm' : 'none',
    meaning: 'Stated on this machine definition in LienCAM\'s own key - any controller can state it.',
    value: formatUccncSettingValue(entry.value),
    ownedBy: null,
    visible: true,
  }))
}

/**
 * EVERY SETTING THIS MACHINE'S CONTROLLER SURFACE OFFERS, behind one shape.
 * A UCCNC machine gets the whole catalogue (1681 rows); a GRBL machine gets
 * the `$`-settings it has actually stated. The catalogues are per-controller
 * because the VOCABULARIES are (ADR-0042) - but what the definition states in
 * LienCAM's own keys is indexed whatever the controller is (WO-1731), so a
 * hand-built machine's stated facts are rows on any controller and no new
 * branch per device was added to get them there.
 */
export function buildSettingsIndex(
  machine: Pick<MachineConfig, 'controller' | 'controllerDefinition' | 'grblSettings' | 'kind'>,
): SettingsIndexRow[] {
  const rows: SettingsIndexRow[] = []
  if (machine.controller === 'uccnc') {
    rows.push(...uccncRows(machine.controllerDefinition?.settings, machineKind(machine), machine.controllerDefinition))
  } else if (isGrblMachine(machine)) {
    rows.push(...grblRows(machine.grblSettings))
  }
  rows.push(...liencamRows(machine, rows))
  return rows
}

/** The index, narrowed to rows whose key, name, meaning or group contains
 *  `query` (case-insensitive). An empty or blank query returns every row. */
export function searchSettingsIndex(
  rows: readonly SettingsIndexRow[], query: string,
): SettingsIndexRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...rows]
  return rows.filter((row) =>
    row.key.toLowerCase().includes(needle)
    || row.name.toLowerCase().includes(needle)
    || row.meaning.toLowerCase().includes(needle)
    || row.group.toLowerCase().includes(needle))
}
