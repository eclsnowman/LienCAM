/**
 * IMPORT A UCCNC `.pro` PROFILE INTO A MACHINE DEFINITION (WO-916 / WO-936).
 *
 * WHY THIS EXISTS RATHER THAN A HAND-WRITTEN LIENCNC LITERAL.
 *
 * Operator opened the machine editor on 2026-08-23 and found a GRBL machine with
 * invented 800/600/100 travel - his machine was nowhere in the product, on a
 * night whose whole purpose was proving the definition drives the machine. The
 * obvious repair is to type his numbers in as a constant. That is the wrong
 * repair: it creates a SECOND COPY of machine facts, and a second copy that
 * disagrees with the board is the exact defect WO-924 exists to kill. His
 * `.pro` is the authority the machine already obeys, so we read it.
 *
 * THE MAPPING IS NOT INVENTED HERE. `Machine.cs:633-740` (ApplyProfile) is a
 * complete, working `.pro`-to-board mapping that the machine session diffed
 * field-by-field against decompiled UCCNC on 2026-08-23 - MaxVel, MaxAccel,
 * SlaveAxis, soft limits, and all 40 pin-table rows identical. This file
 * mirrors THAT, deliberately, key for key. Where the two could drift, the
 * bridge wins and this file is wrong.
 *
 * UNITS - THE ONE PLACE A COPY WOULD SILENTLY MAIM A DRIVE.
 *
 *   Velocity      `.pro` is units/MIN and so is `maxVelocity`. NO conversion.
 *                 (The BRIDGE divides by 60 for the API; src/ never does -
 *                 AxisDefinition.maxVelocity says so at types/index.ts:216.)
 *   Acceleration  units/sec^2 in both. NO conversion.
 *   Enabledelay   **`.pro` IS A COUNT OF 10 ms STEPS. `enableDelayMs` IS
 *                 MILLISECONDS.** This is the trap. `ApplyProfile` reads the
 *                 profile RAW into the board's native units (Machine.cs:715)
 *                 and is correct; `ApplyDefinition` divides ms by 10 to get
 *                 back to those units (EnableDelayUnits, Machine.cs:1150) and
 *                 is ALSO correct. So an importer that copies the raw value
 *                 into `enableDelayMs` gets divided by 10 on the way back out
 *                 and every drive receives an enable delay A TENTH of what the
 *                 machine actually uses. We MULTIPLY BY 10 here. Do not
 *                 "simplify" this, and do not "fix" ApplyDefinition to match -
 *                 that breaks the definition path in the other direction.
 */

import type {
  AxisDefinition,
  AxisHomingDefinition,
  AxisName,
  ControllerDefinition,
  ControllerImportIssue,
  ControllerProfileOnlySetting,
  ControllerSetting,
  ControllerSettingField,
  ControllerSettingKind,
  ControllerSettingPart,
  ControllerSettingRange,
  ControllerSettingRef,
  ControllerSettingScalar,
  ControllerSettingUnit,
  ControllerSettingValue,
  ControllerType,
  MachineCoolantCapability,
  MachineProbeDefaults,
  MachineMCode,
  MachineMacro,
  MachineConfig,
  MachineControllerBoard,
  MachineOutputDefinition,
  MachineReferencePositions,
  NamedSlot,
  PinRef,
  UnnamedSlot,
  UnsentSetting,
  Vec3,
} from '../../types'
import type {
  MachineDefinitionProvenance,
  MachineDefinitionProvenanceEntry,
} from './controller'
import type { BridgePreviewProfileReply, BridgeProfileSetting } from './bridgeTransport'
import { outputTurnedOff } from './machineOutputs'
import { homingZNotFirstMessage } from './operatorMessages'
import {
  uccncBoardDeviceTypeByName,
  uccncBoardName,
  uccncBoardUnknownName,
  withUccncBoardDeviceType,
} from './controllerBoard'
import { DEFAULT_MACHINE_PROBE_DEFAULTS } from './toolTable'
import {
  DEFAULT_HOMING_ORDER,
  LIENCAM_SAFE_Z_KEY,
  UNASSIGNED_PIN,
  UCCNC_SAFE_Z_KEY,
  axisDriveSettingKey,
  axisHomingStatementKey,
  axisHomeBackOffStatementKey,
  axisHomeInputStatementKey,
  createDefaultAxisDefinition,
  createDefaultControllerDefinition,
  controllerSettingValue,
  definitionStatesKey,
  uccncAxisHomeBackOffKey,
  uccncAxisHomingKey,
  withControllerSetting,
  unsentSettingId,
} from '../../types'

/**
 * WHERE THE PROFILE'S OWN RELAYS BECOME ENTRIES IN THE ONE OUTPUT LIST
 * (WO-1649).
 *
 * WO-1637 put a resolver in this file that read UCCNC setting names at the
 * moment a word was typed. It has moved to `machineOutputs.ts`, which reads the
 * machine definition's one output list and knows no controller at all. What is
 * left here is the READ: a `.pro` states its coolant and spindle relays, so the
 * importer turns them into list entries once, the way a GRBL importer or a
 * person filling the definition in by hand would.
 *
 * NOTHING IS INVENTED. Every port, pin, polarity and delay below comes from a
 * key the profile stated; a key the profile omits leaves the pin UNASSIGNED,
 * and the resolver then names that output to the operator rather than guessing
 * wiring for it.
 */

/** A UCCNC relay (`M3`/`M4`/`M7`/`M8`) as the profile stated it: port and pin
 *  as numbers (0 when unstated), negate as stated or null. Null only when
 *  there is no definition at all. */
function uccncRelayPin(
  definition: ControllerDefinition | null | undefined,
  word: 'M3' | 'M4' | 'M7' | 'M8',
): PinRef | null {
  if (!definition) return null
  const stem = `Spindlesetupsettings.${word}relay`
  const port = controllerSettingValue(definition.settings, 'uccnc', `${stem}port`)
  const pin = controllerSettingValue(definition.settings, 'uccnc', `${stem}pin`)
  const negate = controllerSettingValue(definition.settings, 'uccnc', `${stem}pinnegate`)
  return {
    port: port?.kind === 'number' ? port.value : 0,
    pin: pin?.kind === 'number' ? pin.value : 0,
    negate: negate?.kind === 'boolean' ? negate.value : null,
  }
}

function uccncSpindleSetupMs(definition: ControllerDefinition | null | undefined, key: string): number {
  const value = controllerSettingValue(definition?.settings, 'uccnc', `Spindlesetupsettings.${key}`)
  return value?.kind === 'number' && Number.isFinite(value.value) && value.value > 0 ? value.value : 0
}

function uccncSpindleSetupSaysNo(definition: ControllerDefinition | null | undefined, key: string): boolean {
  const value = controllerSettingValue(definition?.settings, 'uccnc', `Spindlesetupsettings.${key}`)
  return value?.kind === 'boolean' && value.value === false
}

/** WO-1703 fix round 3: UCCNC turns its M7 and M8 relays on and off with ONE
 *  setting, `Spindlesetupsettings.Floodmistrelaysenabled`. Both entries carry
 *  this `sharedSwitch`, so the resolver and the Outputs page treat them as the
 *  one switch the controller has (see `MachineOutputDefinition.sharedSwitch`). */
export const UCCNC_COOLANT_RELAYS_SWITCH = 'coolant relays'

/**
 * THE OUTPUT LIST A UCCNC PROFILE STATES.
 *
 * Flood first, then mist, then the spindle relays: that is the order M9 clears
 * them in, and it is the order UCCNC's own Spindle setup page lists them.
 *
 * `Floodmistrelaysenabled=False` means UCCNC switches NO relay on M7 or M8 even
 * where the pin keys are filled in, so the entries are written `disabled`,
 * CARRYING THE PROFILE'S REAL PIN (WO-1703). The words still belong to this
 * machine - M7 is still mist here - so the resolver answers a disabled entry
 * exactly as it answers an unassigned one, and the operator is told which
 * output switches nothing instead of the word going silently to a board that
 * will do nothing with it. The pin is never blanked to say "off": a blanked
 * pin is a fake fact, and the next save wrote it back over the real wiring.
 *
 * The spindle relays are entries with `besideWord`, because UCCNC switches them
 * BESIDE the M3/M4/M5 it already acts on. They are written only when the
 * profile assigns them: an absent spindle relay is not a gap the operator has
 * to fill, it is a machine whose spindle is commanded some other way.
 */
export function uccncProfileOutputs(
  definition: ControllerDefinition | null | undefined,
): MachineOutputDefinition[] {
  const outputs: MachineOutputDefinition[] = []
  const coolantWired = !uccncSpindleSetupSaysNo(definition, 'Floodmistrelaysenabled')
  const offDelayMs = uccncSpindleSetupMs(definition, 'M9delay')
  for (const [word, name, role] of [
    ['M8', 'flood coolant', 'flood'],
    ['M7', 'mist coolant', 'mist'],
  ] as const) {
    const relay = uccncRelayPin(definition, word)
    outputs.push({
      name,
      role,
      onCode: word,
      offCode: null,
      pin: relay ?? { ...UNASSIGNED_PIN },
      onDelayMs: uccncSpindleSetupMs(definition, `${word}ondelay`),
      offDelayMs,
      sharedSwitch: UCCNC_COOLANT_RELAYS_SWITCH,
      ...(coolantWired ? {} : { disabled: true }),
    })
  }
  if (!uccncSpindleSetupSaysNo(definition, 'Spindlerelaysenabled')) {
    for (const word of ['M3', 'M4'] as const) {
      const relay = uccncRelayPin(definition, word)
      if (relay === null || relay.port <= 0 || relay.pin <= 0) continue
      outputs.push({
        name: `${word} spindle relay`,
        onCode: word,
        offCode: 'M5',
        pin: relay,
        onDelayMs: uccncSpindleSetupMs(definition, `${word}ondelay`),
        besideWord: true,
      })
    }
  }
  return outputs
}

/**
 * THE OUTPUT LIST A DEFINITION'S OWN SETTINGS STATE (WO-1675) - the ONE
 * derivation, run by the importer and by every load of a saved definition.
 *
 * A definition that states no UCCNC spindle-setup key (a GRBL or hand-made
 * machine) states no relay, so its list is empty: nothing invented, nothing
 * refused, and every word goes to the controller as written.
 */
export function definitionOutputsFromSettings(
  definition: ControllerDefinition | null | undefined,
): MachineOutputDefinition[] {
  const statesRelaySetup = (definition?.settings ?? []).some((setting) =>
    setting.controller === 'uccnc' && /^spindlesetupsettings\./i.test(setting.key))
  return statesRelaySetup ? uccncProfileOutputs(definition) : []
}

/**
 * A SAVED DEFINITION WITH NO OUTPUT LIST gets the one its settings state
 * (WO-1675). A definition saved before WO-1649 carries the relay settings but
 * no list, and without this its M7/M8/M9 stop resolving on the next build.
 * ONLY AN ABSENT LIST IS FILLED: a list the operator has edited, including an
 * empty one, is theirs and comes back as the same object. A definition whose
 * settings state no relay also comes back as itself - its list would be
 * empty, and absent and empty are the same answer to the resolver.
 *
 * A DEFINITION THAT ALREADY HAS A LIST gets the other half (WO-1703,
 * ADR-0049): `withRelaySettingsFromOutputs` writes the list's own port, pin,
 * negate and on-delay back into `settings`, so a re-pinned relay is not left
 * stating the import snapshot forever.
 */
export function withDerivedOutputs<T extends ControllerDefinition | undefined>(definition: T): T {
  if (definition === undefined || definition === null) return definition
  if (definition.outputs === undefined) {
    const outputs = definitionOutputsFromSettings(definition)
    return outputs.length === 0 ? definition : { ...definition, outputs }
  }
  return withRelaySettingsFromOutputs(definition) as T
}

/** The four UCCNC relay words an outputs-list entry can restate. */
const RELAY_WORDS = ['M3', 'M4', 'M7', 'M8'] as const

/** `settings` with `key` set to `value`, UNLESS it already reads that value -
 *  so a load that changes nothing hands back the same array, the identity
 *  `adoptMachineDocument` and its callers depend on. */
function settingsWithDerivedValue(
  settings: ControllerSetting[] | undefined,
  key: string,
  value: ControllerSettingValue,
): ControllerSetting[] | undefined {
  const current = controllerSettingValue(settings, 'uccnc', key)
  if (current !== null && current.kind === value.kind && current.value === value.value) return settings
  return withControllerSetting(settings, 'uccnc', key, value)
}

/**
 * THE OUTPUTS LIST IS THE WRITER; THESE `Spindlesetupsettings` KEYS ARE
 * DERIVED FROM IT, NEVER THE OTHER WAY ROUND (ADR-0049, WO-1703).
 *
 * `definitionOutputsFromSettings` reads a `.pro`'s relay keys into list
 * entries ONCE, at import; from there the list is the operator's, edited on
 * the Outputs area (`OutputsSection.tsx`, WO-1651) and no longer on a second
 * relay table (`SpindleSection.tsx`'s, deleted by this order). Without this,
 * re-pinning a relay there left `Spindlesetupsettings.M8relaypin` stating the
 * import snapshot forever, because `exportUccncProfile` asks `settings`
 * FIRST - the same trap `DefinitionFields.tsx` documents for a wire's own
 * polarity. So every relay word the list actually carries an entry for has
 * its port, pin, negate and on-delay written back into `settings`, which is
 * the one place the exported `.pro` reads them from.
 *
 * A WORD THE LIST HAS NO ENTRY FOR IS UNTOUCHED. An M3/M4 relay the profile
 * left unwired (`uccncProfileOutputs` skips a relay with no assigned pin) has
 * no list entry to restate it, so its keys stay exactly what the profile
 * said. `Spindlerelaysenabled` and `M9delay` stay settings-only: they are
 * not one entry's own fact.
 *
 * A DISABLED ENTRY STILL CARRIES ITS REAL PIN (`uccncProfileOutputs`), so the
 * restated port/pin is always the wiring, never a mask. `Floodmistrelaysenabled`
 * is restated from the M7/M8 entries' own `disabled` flags: UCCNC has ONE
 * switch for both, so it reads False only when every listed coolant relay is
 * disabled (a mixed list - one on, one off - exports True, the only way the
 * enabled one keeps switching under UCCNC). It is written only when that
 * answer differs from what the settings already say, and an absent key
 * already means "enabled", so a profile that never stated it is left as it
 * was.
 */
export function withRelaySettingsFromOutputs(
  definition: ControllerDefinition,
): ControllerDefinition {
  let settings = definition.settings
  const outputs = definition.outputs ?? []
  // The relay rows are the importer's own: M7/M8 carry the shared coolant
  // switch, M3/M4 carry besideWord. An ordinary row an operator added on the
  // same word (a dust shoe on M8) is never a relay (WO-1703 review).
  const isRelayRow = (entry: (typeof outputs)[number], word: string): boolean =>
    entry.onCode === word
    && ((word === 'M7' || word === 'M8')
      ? entry.sharedSwitch === UCCNC_COOLANT_RELAYS_SWITCH
      : entry.besideWord === true)
  const coolantRelays = outputs.filter((entry) => isRelayRow(entry, 'M7') || isRelayRow(entry, 'M8'))
  if (coolantRelays.length > 0) {
    const enabled = coolantRelays.some((entry) => entry.disabled !== true)
    const statedEnabled = !uccncSpindleSetupSaysNo(definition, 'Floodmistrelaysenabled')
    if (enabled !== statedEnabled) {
      settings = withControllerSetting(
        settings, 'uccnc', 'Spindlesetupsettings.Floodmistrelaysenabled', { kind: 'boolean', value: enabled },
      )
    }
  }
  for (const word of RELAY_WORDS) {
    // A record saved before the stamps existed has unmarked relay rows, listed
    // first by the importer: fall back to the first row on that word.
    const output = outputs.find((entry) => isRelayRow(entry, word))
      ?? (outputs.some((entry) => entry.sharedSwitch !== undefined || entry.besideWord !== undefined)
        ? undefined
        : outputs.find((entry) => entry.onCode === word))
    if (!output) continue
    const stem = `Spindlesetupsettings.${word}relay`
    settings = settingsWithDerivedValue(settings, `${stem}port`, { kind: 'number', value: output.pin.port })
    settings = settingsWithDerivedValue(settings, `${stem}pin`, { kind: 'number', value: output.pin.pin })
    if (output.pin.negate !== null) {
      settings = settingsWithDerivedValue(
        settings, `${stem}pinnegate`, { kind: 'boolean', value: output.pin.negate },
      )
    }
    settings = settingsWithDerivedValue(
      settings, `Spindlesetupsettings.${word}ondelay`, { kind: 'number', value: output.onDelayMs ?? 0 },
    )
  }
  return settings === definition.settings ? definition : { ...definition, settings }
}

/** The pin a mapped accessory's on-word switches on this machine, read from the
 *  one output list. Null when no listed output carries that word with a pin -
 *  a custom macro nobody has wired yet, which is a real answer and not a
 *  guess. (WO-1649: this used to read the profile's relay keys; the profile is
 *  now read into the list at import, so the list is the only source.) */
export function vacuumRelayFromUccncDefinition(
  definition: ControllerDefinition | null | undefined,
  onCode: MachineMCode,
): PinRef | null {
  const hit = (definition?.outputs ?? []).find((output) => output.onCode === onCode)
  if (hit === undefined || outputTurnedOff(hit, definition?.outputs ?? [])) return null
  return hit.pin.port > 0 && hit.pin.pin > 0 ? hit.pin : null
}
// WO-1003 - the VFD format this file derives a CANDIDATE for. Types only,
// plus the role list, so the derivation cannot fall out of step with the
// format it is a partial view of. Nothing here builds a `VfdDefinition`:
// see the WO-1003 block at the foot of this file for why it must not.
import type {
  VfdParity,
  VfdProtocol,
  VfdReadFunction,
  VfdRegister,
  VfdRegisterRole,
  VfdSerialLink,
  VfdTcpLink,
  VfdWriteFunction,
} from './vfd/vfdDefinition'
import { VFD_REGISTER_ROLES } from './vfd/vfdDefinition'

/**
 * THE SECTIONS THAT DESCRIBE THE MACHINE, and therefore the only ones whose
 * unread keys are a gap in this software (WO-947).
 *
 * A `.pro` also carries LIVE STATE (tool table, work offsets, machine
 * coordinates, statistics) and UCCNC's OWN APPLICATION PREFERENCES (screenset,
 * appearance, hotkeys, its CAM settings). Neither belongs on a "configure your
 * machine" page and neither is a gap in this product - carrying a work offset
 * into a project record and showing it as an unsent machine setting would be a
 * new lie in the shape of the one this order exists to remove.
 *
 * THIS SPLIT IS A JUDGEMENT and it is the same judgement, deliberately, as
 * `tools/pro-coverage.mjs`'s `CLASS.config` - the two must agree or the
 * hitlist and the page will report different totals for the same profile. If
 * one changes, change both.
 */
const CONFIG_SECTIONS: readonly string[] = [
  'axessettingscontrolX', 'axessettingscontrolY', 'axessettingscontrolZ',
  'axessettingscontrolA', 'axessettingscontrolB', 'axessettingscontrolC',
  'Spindlesetupsettings', 'Generalsettings', 'IOsetupsettings',
  'SpindlePIDsettings', 'AUXencodersettings', 'Digitizesettings', 'Probing',
  'FaultSignals', 'ModbusEZ', 'Modbus_connection_0', 'Modbus_function_0_0',
  'Modbus_function_0_1', 'Modbus_function_0_2', 'Modbus_function_0_3',
  'Inputtriggersettings', 'Outputtriggersettings', 'Macroloops',
  'Laserengraveplugin', 'RFHsettings',
]

/** WO-1094: Phase B also needs the six stored XYZ work-zero triples in the
 * definition sent to the bridge. They remain outside CONFIG_SECTIONS because
 * they are live app-owned state, not part of WO-1037's 1680 configuration-key
 * ruler; this list exists only to put the startup values in our definition. */
const WORK_OFFSET_SECTIONS: readonly string[] = [
  'Workoffset_G54', 'Workoffset_G55', 'Workoffset_G56',
  'Workoffset_G57', 'Workoffset_G58', 'Workoffset_G59',
]
const WORK_OFFSET_KEYS: readonly string[] = ['WorkoffsetX', 'WorkoffsetY', 'WorkoffsetZ']

/** The axes a `.pro` carries a section for, in the order UCCNC writes them. */
const PROFILE_AXES: readonly AxisName[] = ['X', 'Y', 'Z', 'A', 'B', 'C']

/** `[axessettingscontrolX]` - UCCNC's own section naming. */
const axisSection = (axis: AxisName): string => `axessettingscontrol${axis}`

/** The controller spelling is retained for UCCNC export, while appKey gives
 * every consumer the same controller-independent per-axis question. */
export function axisDriveAppKey(rawKey: string): string | undefined {
  const match = /^axessettingscontrol([XYZABC])\.(.+)$/i.exec(rawKey)
  if (!match) return undefined
  const axis = match[1].toUpperCase() as AxisName
  const part = ({
    currhilowportnumber: 'currentHiLow.port',
    currhilowpinnumber: 'currentHiLow.pin',
    currhilowpinnegate: 'currentHiLow.negate',
    rotaryaxis: 'rotary',
    rotaryrollover: 'rotaryRollover',
  } as const)[match[2].toLowerCase() as
    | 'currhilowportnumber'
    | 'currhilowpinnumber'
    | 'currhilowpinnegate'
    | 'rotaryaxis'
    | 'rotaryrollover']
  return part === undefined ? undefined : axisDriveSettingKey(axis, part)
}

/**
 * UCCNC WRITES THE SLAVE AS A NAME, NOT AN INDEX - `Slaveaxis=A`, or the
 * literal string `None`. Verified against Operator's own profile, where Y reads
 * `Slaveaxis=A` and X and Z read `None`.
 *
 * The bridge does the same lookup by name (`Machine.cs:747`,
 * `Array.IndexOf(axisNames, S(sec,"Slaveaxis","None"))`) and its comment says
 * why it matters: "Missing this drives one side of a gantry and racks it."
 * Y+A ARE OPERATOR'S GANTRY. Reading this key as a number would silently drop the
 * pairing on the one machine we are importing.
 */
const SLAVE_NAMES: readonly AxisName[] = ['X', 'Y', 'Z', 'A', 'B', 'C']

/**
 * THE UCCNC SETTING CATALOGUE (WO-1037) - what a UCCNC machine can be told.
 *
 * `UnsentSetting` carries a machine fact as text and deliberately does not
 * know what it means. That is honest carriage, and it is not a machine
 * definition: measured on Operator's real profile, 1489 of 1680 machine
 * configuration keys were text triples, so this software could not express
 * 89% of what his machine can do and no from-scratch profile could carry
 * those features back out (ADR-0044 requirement 5).
 *
 * This is the model that closes that. One entry per key UCCNC has, with its
 * MEANING, its UNIT and whatever RANGE is actually known - so a UI can present
 * it, a person can edit it, and an exporter can write it back.
 *
 * THE HONEST SPLIT, AND THE CLAIM THIS DOES NOT MAKE. Every one of the 1680
 * keys is typed and round-trips, and none is unmodelled. But "1680 of 1680
 * MODELLED WITH AN ESTABLISHED MEANING" is NOT true and is not claimed here:
 * three keys - `Probing.Blower`, `Probing.FixedProbePos` and
 * `Probing.MobileProbePos` - are packed records UCCNC documents nowhere, and
 * 37 of their slots are typed but UNNAMED (`UnnamedSlot`). The split is
 * 1643 established / 37 typed-but-unnamed / 0 unmodelled, charging a whole key
 * against every unnamed slot so the number can never overstate coverage.
 * `definitionModelCoverage.wo1037` pins all three, and naming one of the 37
 * means establishing it from UCCNC's own documentation or from observed
 * machine behaviour - never from what the number happens to look like.
 *
 * IT IS A CATALOGUE, NOT 1680 BESPOKE TYPES. Four sections are tables that
 * repeat one row shape 15 to 96 times; `table()` builds those from the row.
 * The hand-written part is ~380 field descriptions, which is the number of
 * DISTINCT things a UCCNC machine can be told.
 *
 * WHAT `ownedBy` MEANS, AND WHAT IT DOES NOT. Some keys are already held by a
 * purpose-built field - `Velocity` is `AxisDefinition.maxVelocity`, which is
 * the value the bridge actually drives a motor with. `ownedBy` records that so
 * a reader knows where to look, and so nothing copies a fact into two places.
 * It NEVER decides what gets stored: that is decided by whether a reader
 * actually called `rawOf` for the key, exactly as the unsent set already is.
 * The two can honestly differ - `readPin` skips a negate key on an unassigned
 * pin, so that key is owned in principle and unheld in fact, and it belongs in
 * `settings` because nothing else is holding it.
 *
 * THE VOCABULARY IS UCCNC'S. Keys are spelled as UCCNC spells them, including
 * `MaxLinearaddlenght` and `Digitialsyncoutputpinnumber1`. A corrected
 * spelling is a key nobody can look up in UCCNC's own documentation, and one
 * that would not match the file.
 */

type SettingRange = ControllerSettingRange

const NO_RANGE: SettingRange = { min: null, max: null }
const atLeast = (min: number): SettingRange => ({ min, max: null })
const between = (min: number, max: number): SettingRange => ({ min, max })
const PERCENT: SettingRange = { min: 0, max: 100 }

/** One catalogue entry before the section name is attached. */
interface Spec {
  key: string
  meaning: string
  kind: ControllerSettingKind
  unit: ControllerSettingUnit
  range: SettingRange
  options?: readonly string[]
  parts?: readonly ControllerSettingPart[]
  ownedBy?: string
  row?: { table: string; index: number; field: string }
}

const num = (
  key: string, meaning: string,
  unit: ControllerSettingUnit = 'count', range: SettingRange = NO_RANGE,
  ownedBy?: string,
): Spec => ({ key, meaning, kind: 'number', unit, range, ownedBy })

const bool = (key: string, meaning: string, ownedBy?: string): Spec =>
  ({ key, meaning, kind: 'boolean', unit: 'none', range: NO_RANGE, ownedBy })

const text = (key: string, meaning: string, ownedBy?: string): Spec =>
  ({ key, meaning, kind: 'text', unit: 'none', range: NO_RANGE, ownedBy })

const choice = (
  key: string, meaning: string, options: readonly string[], ownedBy?: string,
): Spec => ({ key, meaning, kind: 'enum', unit: 'none', range: NO_RANGE, options, ownedBy })

const compound = (
  key: string, meaning: string, parts: readonly ControllerSettingPart[],
): Spec => ({ key, meaning, kind: 'tuple', unit: 'none', range: NO_RANGE, parts })

/** A part of a compound value whose meaning IS established. */
const part = (
  meaning: string, kind: 'number' | 'boolean' | 'text' | 'enum',
  unit: ControllerSettingUnit = 'count', range: SettingRange = NO_RANGE,
  options: readonly string[] | null = null,
): NamedSlot => ({ named: true, meaning, kind, unit, range, options })

/**
 * A slot whose TYPE and POSITION are read off the file and whose MEANING UCCNC
 * does not document and this software has not established.
 *
 * It takes a `kind` and nothing else - there is deliberately no way to pass a
 * label. The previous attempt's helper took a `meaning` string and set a flag
 * beside it, so every unnamed slot still shipped a confident-sounding sentence
 * ("slot 3 of the fixed probe position") that nobody had checked. Counted is
 * not the same as unnamed; this is unnamed.
 */
const unnamedSlot = (kind: 'number' | 'boolean' | 'text' | 'enum'): UnnamedSlot =>
  ({ named: false, meaning: 'unknown', kind, unit: 'none',
    range: { min: null, max: null }, options: null })

/** A port/pin/negate triple, which is how UCCNC writes every wire. */
const wire = (
  portKey: string, pinKey: string, negateKey: string, what: string, owner?: string,
): Spec[] => [
  num(portKey, `the port ${what} is wired to`, 'port', atLeast(0), owner && `${owner}.port`),
  num(pinKey, `the pin ${what} is wired to`, 'pin', atLeast(0), owner && `${owner}.pin`),
  bool(negateKey, `whether ${what} is inverted`, owner && `${owner}.negate`),
]

/**
 * A repeating table, built once from its row shape.
 *
 * The row field name folds the index out of the key - `Pin7` becomes `Pin#`,
 * `AUXencoder3portB` becomes `AUXencoder#portB` - so a UI can group 384 keys
 * into 96 rows of 4 without a second list to keep in step.
 */
// `first` exists because UCCNC does not agree with itself: its trigger,
// fault and pulley tables number from 1 and its macro loops number from 0.
// Following the file is the only option - a row this software renumbered is
// a row that does not match the key the machine actually writes.
const table = (
  name: string, count: number, make: (index: number) => Spec[], first = 1,
): Spec[] => {
  const out: Spec[] = []
  for (let index = first; index < first + count; index++) {
    for (const spec of make(index)) {
      const field = spec.key.replace(new RegExp(`${index}(?!\\d)`), '#')
      out.push({ ...spec, row: { table: name, index, field } })
    }
  }
  return out
}

/** Attach the section name and fill the parts every entry must carry. */
const section = (name: string, specs: readonly Spec[]): ControllerSettingField[] =>
  specs.map((spec) => ({
    controller: 'uccnc' as const,
    key: `${name}.${spec.key}`,
    group: name,
    row: spec.row ?? null,
    meaning: spec.meaning,
    kind: spec.kind,
    unit: spec.unit,
    range: spec.range,
    options: spec.options ?? null,
    parts: spec.parts ?? null,
    ownedBy: spec.ownedBy ?? null,
  }))

/** UCCNC writes an axis name or the literal `None` wherever an axis is
 *  optional. Reading it as an index is what racks a gantry - see
 *  `SLAVE_NAMES`. */
const AXIS_OR_NONE = ['X', 'Y', 'Z', 'A', 'B', 'C', 'None'] as const

/**
 * One axis section. Six of these exist and UCCNC writes them unequally: only
 * X/Y/Z carry `Slaveaxis` (a slave is not itself a master), only A/B/C carry
 * the rotary keys, and only A carries the drag-knife block. The catalogue
 * follows the file rather than offering every key on every axis - a key UCCNC
 * never writes for an axis is not part of that axis's vocabulary.
 */
function axisSpecs(axis: AxisName): Spec[] {
  const own = `axes[${axis}]`
  const home = `homing.perAxis[${axis}]`
  const specs: Spec[] = [
    bool('Axisenabled', 'whether this axis exists on this machine', `${own}.enabled`),
    num('Stepsperunit', 'motor steps per one unit of travel', 'steps/unit', atLeast(0),
      `${own}.stepsPerUnit`),
    num('Velocity', 'the fastest this axis may move', 'units/min', atLeast(0),
      `${own}.maxVelocity`),
    num('Acceleration', 'how hard this axis may change speed', 'units/sec^2', atLeast(0),
      `${own}.acceleration`),
    num('Compaccel', 'the acceleration UCCNC allows while blending a corner in '
      + 'constant-velocity mode', 'units/sec^2', atLeast(0)),
    num('Softlimitpositive', 'the furthest positive machine coordinate this axis may reach',
      'units', NO_RANGE, `${own}.softLimitMax`),
    num('Softlimitnegative', 'the furthest negative machine coordinate this axis may reach',
      'units', NO_RANGE, `${own}.softLimitMin`),
    ...wire('Stepportnumber', 'Steppinnumber', 'Steppinnegate',
      `this axis's step output`, `${own}.stepPin`),
    ...wire('Dirportnumber', 'Dirpinnumber', 'Dirpinnegate',
      `this axis's direction output`, `${own}.dirPin`),
    ...wire('Enaportnumber', 'Enapinnumber', 'Enapinnegate',
      `this axis's drive enable output`, `${own}.enablePin`),
    ...wire('Homeportnumber', 'Homepinnumber', 'Homepinnegate',
      `this axis's home switch`, `${own}.homePin`),
    ...wire('Limitminusportnumber', 'Limitminuspinnumber', 'Limitminuspinnegate',
      `this axis's negative limit switch`, `${own}.limitMinusPin`),
    ...wire('Limitplusportnumber', 'Limitpluspinnumber', 'Limitpluspinnegate',
      `this axis's positive limit switch`, `${own}.limitPlusPin`),
    ...wire('Currhilowportnumber', 'Currhilowpinnumber', 'Currhilowpinnegate',
      `this axis's drive current hi/lo output, which drops holding current when idle`),
    num('Enabledelay', 'how long UCCNC waits after enabling the drive before it may step. '
      + 'UCCNC counts this in 10 ms steps, not milliseconds', '10ms-steps', atLeast(0),
      `${own}.enableDelayMs`),
    bool('Backlashenable', 'whether backlash compensation runs on this axis',
      `${own}.backlash.enabled`),
    num('Backlashdistance', 'how much lost motion this axis has when it reverses',
      'units', atLeast(0), `${own}.backlash.distance`),
    bool('Homedirectionpositive', 'whether homing drives this axis positive',
      `${home}.direction`),
    num('Homingspeedup', 'the fast search toward the home switch', 'units/min', atLeast(0),
      `${home}.fastSpeed`),
    num('Homingspeeddown', 'the slow re-approach onto the home switch', 'units/min',
      atLeast(0), `${home}.slowSpeed`),
    num('Homebackoff', 'how far the axis retreats between the fast and slow home '
      + 'approaches. It is NOT a final retreat and it does not leave the axis off its '
      + 'switch', 'units', atLeast(0), `${home}.backOff`),
    num('Homingvalue', 'the machine coordinate this axis is set to at its home switch',
      'units', NO_RANGE, `${home}.homingValue`),
    bool('Homeautozero', 'whether homing also zeroes the work offset for this axis',
      `${home}.autoZero`),
  ]
  if (axis === 'X' || axis === 'Y' || axis === 'Z') {
    specs.push(choice('Slaveaxis',
      'the axis driven in lockstep with this one, for a gantry. UCCNC writes an axis '
      + 'NAME here, or the literal None', AXIS_OR_NONE, `${own}.slaveAxis`))
  }
  if (axis === 'A' || axis === 'B' || axis === 'C') {
    specs.push(
      bool('Rotaryaxis', 'whether this axis turns in degrees rather than moving in units'),
      bool('Rotaryrollover', 'whether this axis wraps back to 0 after 360 degrees'),
    )
  }
  if (axis === 'A') {
    specs.push(
      bool('Dragknifeenabled', 'whether this axis steers a tangential drag knife'),
      num('Dragknifestopatangle', 'the direction change above which the knife stops to '
        + 'swivel', 'degrees', between(0, 360)),
      num('Dragkniferetractatangle', 'the direction change above which the knife lifts '
        + 'before swivelling', 'degrees', between(0, 360)),
      num('Dragkniferetractheight', 'how far the knife lifts to swivel', 'units', atLeast(0)),
      num('Dragknifemovebackfeedrate', 'the feed for the knife move-back after a swivel',
        'units/min', atLeast(0)),
      num('Dragknifepulloutfeedrate', 'the feed for the knife pull-out before a swivel',
        'units/min', atLeast(0)),
    )
  }
  return specs
}

const GENERAL_SPECS: Spec[] = [
  text('Profilename', 'what UCCNC calls this profile', 'MachineConfig.name'),
  bool('Constantvelocitymode', 'whether UCCNC blends moves instead of stopping at every '
    + 'corner'),
  num('Stopatangle', 'the direction change above which constant-velocity blending stops '
    + 'and the machine comes to rest', 'degrees', between(0, 180)),
  num('Lookaheadlines', 'how many g-code lines UCCNC plans ahead', 'count', atLeast(1)),
  bool('Softlimitsenable', 'whether the per-axis soft limits are enforced'),
  ...[1, 2, 3, 4, 5, 6].map((slot) => choice(`Homesequence${slot}`,
    `the axis homed ${slot === 1 ? 'first' : `in position ${slot}`}, or None for an unused `
    + 'slot', AXIS_OR_NONE, 'homing.order')),
  num('Linearerror', 'how far a blended path may deviate from the programmed line',
    'units', atLeast(0)),
  num('Cornerserror', 'how far a blended corner may deviate from the programmed corner',
    'units', atLeast(0)),
  num('USBbuffersize', 'how much motion UCCNC keeps buffered on the controller', 's',
    atLeast(0)),
  num('POSDROsdigits', 'how many decimals the position readouts show', 'count', atLeast(0)),
  num('Doontoolchange', 'UCCNC\'s own code for what M6 does', 'count', atLeast(0)),
  num('MaxLinearaddlenght', 'the longest segment UCCNC will add when it splits a move '
    + '(UCCNC\'s own spelling)', 'units', atLeast(0)),
  num('MaxLinearunificationlenght', 'the longest run of short segments UCCNC will merge '
    + 'into one (UCCNC\'s own spelling)', 'units', atLeast(0)),
  num('Kernelfreq', 'UCCNC\'s own index for the motion kernel frequency', 'count',
    atLeast(0)),
  num('SafeZ', 'the machine Z height UCCNC retracts to before a cross-table move', 'units'),
  num('G73_backoff', 'the retract between pecks in a G73 peck-drilling cycle', 'units',
    atLeast(0)),
  bool('Maximisescreenonstartup', 'whether UCCNC opens its own window maximised'),
  bool('Dwellinseconds', 'whether G4 P values are seconds rather than milliseconds'),
  num('Runmodewhenunknowngcode', 'UCCNC\'s own code for what it does when it meets '
    + 'g-code it does not know', 'count', atLeast(0)),
  bool('Softlimitsgcodeprecheck', 'whether a loaded file is checked against the soft '
    + 'limits before it runs'),
  bool('Precompilemacrosonstartup', 'whether macros are compiled when UCCNC starts'),
  num('Arcradiustolerance', 'how far an arc\'s two radii may disagree before UCCNC '
    + 'refuses it', 'units', atLeast(0)),
  bool('ResetG68onfileload', 'whether coordinate rotation is cleared when a file loads'),
  bool('ResetG51onfileload', 'whether scaling is cleared when a file loads'),
  bool('ResetG94onfileload', 'whether the feed mode is reset to units-per-minute when a '
    + 'file loads'),
  num('Debounce', 'how long an input must hold steady before UCCNC believes it, in '
    + 'UCCNC\'s own debounce counts', 'count', atLeast(0)),
  num('DebounceTHC', 'the debounce for the torch height control inputs', 'count',
    atLeast(0)),
  num('DebounceHome', 'the debounce for the home switches', 'count', atLeast(0)),
  num('DebounceProbe1', 'the debounce for the first probe input', 'count', atLeast(0)),
  num('DebounceProbe2', 'the debounce for the second probe input', 'count', atLeast(0)),
  bool('G41G42roundjoints', 'whether cutter compensation rounds outside joints instead '
    + 'of sharpening them'),
  bool('CheckHomeonCycleStart', 'whether cycle start refuses on a machine that has not '
    + 'been homed'),
  bool('ResetDereferenceHomes', 'whether a reset discards the homed reference'),
  bool('Mandatoryhoming', 'whether the machine must be homed before it will move'),
]

const IO_SPECS: Spec[] = [
  ...wire('Estopportnumber', 'Estoppinnumber', 'Estoppinnegate',
    'the emergency stop input', 'io.estop'),
  ...wire('Probeportnumber', 'Probepinnumber', 'Probepinnegate',
    'the first probe input', 'io.probe'),
  ...wire('Probeport2number', 'Probepin2number', 'Probepin2negate',
    'the second probe input', 'io.probe2'),
  ...wire('Chargepumpportnumber', 'Chargepumppinnumber', 'Chargepumppinnegate',
    'the charge pump output, the watchdog signal a drive enclosure requires before it '
    + 'will power the drives'),
  bool('Chargepumplasermodeon', 'whether the charge pump switches to its laser waveform'),
  bool('Chargepumpalwayson', 'whether the charge pump runs even while the machine is idle'),
  ...wire('Chargepump2portnumber', 'Chargepump2pinnumber', 'Chargepump2pinnegate',
    'the second charge pump output'),
  ...wire('CurrentHiLoportnumber', 'CurrentHiLopinnumber', 'CurrentHiLopinnegate',
    'the machine-wide drive current hi/lo output'),
  num('Indexportnumber', 'the port the spindle index pulse is wired to', 'port', atLeast(0)),
  num('Indexpinnumber', 'the pin the spindle index pulse is wired to', 'pin', atLeast(0)),
  num('Indexprescaler', 'how many index pulses make one spindle revolution', 'count',
    atLeast(1)),
  bool('THCenable', 'whether torch height control runs'),
  ...wire('THConport', 'THConpin', 'THConpinnegate',
    'the torch-height-control arc-on input'),
  ...wire('THCupport', 'THCuppin', 'THCuppinnegate', 'the torch-height-control up input'),
  ...wire('THCdownport', 'THCdownpin', 'THCdownpinnegate',
    'the torch-height-control down input'),
  num('THCmin', 'the lowest arc voltage torch height control will hold', 'volts',
    atLeast(0)),
  num('THCmax', 'the highest arc voltage torch height control will hold', 'volts',
    atLeast(0)),
  num('THCfeed', 'the speed torch height control moves Z at', 'units/min', atLeast(0)),
  bool('THCalwayson', 'whether torch height control corrects even without an arc-on signal'),
  num('THCondelay', 'how long after arc-on before torch height control starts correcting',
    'ms', atLeast(0)),
  bool('THCdelayenable', 'whether the arc-on delay is applied at all'),
  bool('THCantidiveenable', 'whether anti-dive holds Z still when the arc voltage rises '
    + 'in a corner'),
  num('THCantidivepercent', 'the fraction of programmed feed below which anti-dive '
    + 'freezes Z', 'percent', PERCENT),
  ...wire('THCenableoutport', 'THCenableoutpin', 'THCenableoutpinnegate',
    'the torch-height-control enabled output'),
  ...wire('THCantidiveoutport', 'THCantidiveoutpin', 'THCantidiveoutpinnegate',
    'the anti-dive active output'),
  ...wire('THCantidownoutport', 'THCantidownoutpin', 'THCantidownoutpinnegate',
    'the anti-down active output'),
  bool('THCantidownenable', 'whether anti-down stops torch height control driving Z down'),
  num('Plasmapierceheight', 'the Z height the torch pierces at before it drops to cut',
    'units', atLeast(0)),
  num('MPG1portA', 'the port the first handwheel\'s A channel is wired to', 'port',
    atLeast(0)),
  num('MPG1pinA', 'the pin the first handwheel\'s A channel is wired to', 'pin', atLeast(0)),
  num('MPG1portB', 'the port the first handwheel\'s B channel is wired to', 'port',
    atLeast(0)),
  num('MPG1pinB', 'the pin the first handwheel\'s B channel is wired to', 'pin', atLeast(0)),
  num('MPG1prescaler', 'how many handwheel counts make one step of motion', 'ratio',
    atLeast(1)),
  num('MPG1filter', 'how much the handwheel signal is smoothed, in UCCNC\'s own filter '
    + 'counts', 'count', atLeast(0)),
  num('MPG1speedmultiplier', 'how far one handwheel count moves the machine, as a '
    + 'multiplier', 'ratio', atLeast(0)),
  bool('MPG1attachtoJRO', 'whether the first handwheel drives the jog rate override '
    + 'instead of an axis'),
  num('FROchannel', 'the analog input channel the feed rate override knob is on', 'count',
    atLeast(0)),
  num('SROchannel', 'the analog input channel the spindle speed override knob is on',
    'count', atLeast(0)),
  num('JROchannel', 'the analog input channel the jog rate override knob is on', 'count',
    atLeast(0)),
  num('FROminpercent', 'the feed override the knob reads at its low end', 'percent',
    PERCENT),
  num('FROmaxpercent', 'the feed override the knob reads at its high end', 'percent',
    atLeast(0)),
  num('SROminpercent', 'the spindle override the knob reads at its low end', 'percent',
    PERCENT),
  num('SROmaxpercent', 'the spindle override the knob reads at its high end', 'percent',
    atLeast(0)),
  num('JROminpercent', 'the jog override the knob reads at its low end', 'percent',
    PERCENT),
  num('JROmaxpercent', 'the jog override the knob reads at its high end', 'percent',
    atLeast(0)),
  num('SPPWMchannel', 'the analog output channel the spindle PWM is on', 'count',
    atLeast(0)),
  ...[1, 2, 3, 4].flatMap((slot) => [
    num(`Ana${slot}invarnum`, `the UCCNC variable analog input ${slot} is read into`,
      'count', atLeast(0)),
    num(`Ana${slot}outvarnum`, `the UCCNC variable analog output ${slot} is written from`,
      'count', atLeast(0)),
  ]),
  ...wire('Laseroutputportnumber', 'Laseroutputpinnumber', 'Laseroutputpinnegate',
    'the laser fire output'),
  ...table('Digital sync outputs', 10, (index) => wire(
    `Digitialsyncoutputportnumber${index}`,
    `Digitialsyncoutputpinnumber${index}`,
    `Digitialsyncoutputpinnegate${index}`,
    `digital sync output ${index}, which switches in step with motion rather than `
    + 'between moves (UCCNC\'s own spelling)',
  )),
]

const SPINDLE_SPECS: Spec[] = [
  bool('IsSpindleinPWMMode', 'whether the spindle is commanded by PWM rather than by '
    + 'step and direction'),
  ...wire('SpindlePWMoutport', 'SpindlePWMoutpin', 'SpindlePWMoutpinnegate',
    'the spindle PWM output'),
  ...wire('SpindlePWMdirport', 'SpindlePWMdirpin', 'SpindlePWMdirpinnegate',
    'the spindle PWM direction output'),
  num('SpindlePWMfrequency', 'the carrier frequency of the spindle PWM', 'hz', atLeast(0)),
  num('SpindlePWMminpercent', 'the duty cycle that means minimum speed', 'percent',
    PERCENT),
  num('SpindlePWMmaxpercent', 'the duty cycle that means maximum speed', 'percent',
    PERCENT),
  ...wire('Spindlestepport', 'Spindlesteppin', 'Spindlesteppinnegate',
    'the spindle step output'),
  ...wire('Spindledirport', 'Spindledirpin', 'Spindledirpinnegate',
    'the spindle direction output'),
  num('Spindlestepsperunit', 'steps per one spindle revolution', 'steps/rev', atLeast(0)),
  num('Spindleacceleration', 'how fast the spindle may change speed', 'rpm/sec',
    atLeast(0)),
  num('Spindleminvelocity', 'the slowest speed this spindle may be commanded to', 'rpm',
    atLeast(0)),
  num('Spindlemaxvelocity', 'the fastest speed this spindle may be commanded to', 'rpm',
    atLeast(0)),
  bool('Spindlerelaysenabled', 'whether M3 and M4 switch relay outputs'),
  ...wire('M3relayport', 'M3relaypin', 'M3relaypinnegate',
    'the relay M3 (spindle clockwise) switches'),
  ...wire('M4relayport', 'M4relaypin', 'M4relaypinnegate',
    'the relay M4 (spindle counter-clockwise) switches'),
  num('M3ondelay', 'how long M3 waits for the spindle to come up before motion resumes',
    'ms', atLeast(0)),
  num('M3offdelay', 'how long M5 waits for the spindle to stop after an M3', 'ms',
    atLeast(0)),
  num('M4ondelay', 'how long M4 waits for the spindle to come up before motion resumes',
    'ms', atLeast(0)),
  num('M4offdelay', 'how long M5 waits for the spindle to stop after an M4', 'ms',
    atLeast(0)),
  bool('Floodmistrelaysenabled', 'whether M7 and M8 switch relay outputs'),
  ...wire('M7relayport', 'M7relaypin', 'M7relaypinnegate', 'the relay M7 (mist) switches'),
  ...wire('M8relayport', 'M8relaypin', 'M8relaypinnegate', 'the relay M8 (flood) switches'),
  num('M7ondelay', 'how long M7 waits before motion resumes', 'ms', atLeast(0)),
  num('M8ondelay', 'how long M8 waits before motion resumes', 'ms', atLeast(0)),
  num('M9delay', 'how long M9 waits after turning the coolant off', 'ms', atLeast(0)),
  num('EncoderAport', 'the port the spindle encoder A channel is wired to', 'port',
    atLeast(0)),
  num('EncoderApin', 'the pin the spindle encoder A channel is wired to', 'pin', atLeast(0)),
  num('EncoderBport', 'the port the spindle encoder B channel is wired to', 'port',
    atLeast(0)),
  num('EncoderBpin', 'the pin the spindle encoder B channel is wired to', 'pin', atLeast(0)),
  bool('Encoderreversedirection', 'whether the spindle encoder counts the other way round'),
  num('EncoderPPR', 'pulses the spindle encoder gives per revolution', 'count', atLeast(1)),
  bool('Usepulleys', 'whether the spindle speed is scaled through a pulley table'),
  num('Pulleyinuse', 'which pulley of the table is fitted right now', 'count',
    between(1, 15)),
  ...table('Pulleys', 15, (index) => [
    num(`Pulleyratio${index}`, `the spindle-to-motor ratio of pulley ${index}`, 'ratio',
      atLeast(0)),
    num(`Pulleyminvel${index}`, `the slowest speed pulley ${index} can hold`, 'rpm',
      atLeast(0)),
    num(`Pulleymaxvel${index}`, `the fastest speed pulley ${index} can hold`, 'rpm',
      atLeast(0)),
  ]),
]

const SPINDLE_PID_SPECS: Spec[] = [
  bool('PIDenable', 'whether closed-loop spindle speed control runs'),
  num('Kp', 'the proportional gain of the spindle speed loop', 'ratio'),
  num('Ki', 'the integral gain of the spindle speed loop', 'ratio'),
  num('Kd', 'the derivative gain of the spindle speed loop', 'ratio'),
  num('Samplingtime', 'how often the spindle speed loop runs', 'ms', atLeast(0)),
]

const AUX_ENCODER_SPECS: Spec[] = [
  ...table('Aux encoders', 6, (index) => [
    num(`AUXencoder${index}portA`, `the port auxiliary encoder ${index} A channel is on`,
      'port', atLeast(0)),
    num(`AUXencoder${index}pinA`, `the pin auxiliary encoder ${index} A channel is on`,
      'pin', atLeast(0)),
    num(`AUXencoder${index}portB`, `the port auxiliary encoder ${index} B channel is on`,
      'port', atLeast(0)),
    num(`AUXencoder${index}pinB`, `the pin auxiliary encoder ${index} B channel is on`,
      'pin', atLeast(0)),
  ]),
  ...table('Aux encoder scaling', 6, (index) => [
    num(`Aux${index}Encodercountsper`,
      `how many counts of auxiliary encoder ${index} make one unit`, 'ratio', atLeast(0)),
  ]),
]

const DIGITIZE_SPECS: Spec[] = [
  bool('Addaxisnames', 'whether each digitised point is written with its axis letters'),
  ...(['X', 'Y', 'Z', 'A', 'B', 'C'] as const).map((axis) => bool(`${axis}include`,
    `whether the ${axis} coordinate is written for each digitised point`)),
  bool('Commaseparation', 'whether digitised coordinates are separated by commas'),
  text('Filenametosave', 'the file digitised points are written to'),
  num('Numberofdigits', 'how many decimals each digitised coordinate is written with',
    'count', atLeast(0)),
  num('Probedia', 'the diameter of the probe tip used for digitising', 'units', atLeast(0)),
  bool('Clearfilenamewhenfinished', 'whether the output file name is cleared after a run'),
]

/** The eleven probing routines UCCNC saves settings for, in its own order.
 *  `Mode` is an index into this list. */
const PROBE_MODES = [
  'Tool', 'Simple', 'Angle', 'Pocket', 'Outer', 'InnerCorner', 'OuterCorner',
  'RectInner', 'CircleInner', 'RectOuter', 'CircleOuter',
] as const

/** One (axis, distance) leg of a probing move, which is how UCCNC writes every
 *  probe direction. */
const probeLeg = (which: string): ControllerSettingPart[] => [
  part(`the axis probed ${which}`, 'enum', 'none', NO_RANGE, ['X', 'Y', 'Z', 'A', 'B', 'C']),
  part(`how far the probe may travel ${which} before it gives up`, 'number', 'units'),
]

/**
 * THE FIFTEEN LIVE PROBING SETTINGS, IN THE ORDER THE SECTION WRITES THEM.
 *
 * These fifteen keys are written as one consecutive block - `GageHeight`
 * first, `Axis2CountDia` last - and that ORDER is load-bearing rather than
 * cosmetic: `Set_<mode>Probe` is this same block saved per routine, packed
 * into one comma-separated line, element for element. So the list is declared
 * once and used twice, and `PROBE_SAVED_ORDER` below is what WO-1037's suite
 * checks against the profile. If UCCNC ever writes the block in another
 * order, the two uses cannot drift apart, because there is only one list.
 */
const PROBE_LIVE_SETTINGS: Spec[] = [
  num('GageHeight', 'the height of the fixed tool-setter pad above the table', 'units',
    atLeast(0)),
  num('FineDistance', 'the final slow approach distance', 'units', atLeast(0)),
  num('Retract', 'how far the probe backs off after a touch', 'units', atLeast(0)),
  num('FastFeed', 'the fast search feed', 'units/min', atLeast(0)),
  num('FineFeed', 'the slow measuring feed', 'units/min', atLeast(0)),
  bool('ZeroProbedAxis', 'whether the probed axis is zeroed when the touch lands'),
  bool('ZeroOnAllOffsets', 'whether the probed result is applied to every work offset'),
  bool('SingleProbeMode', 'whether a routine takes a single touch instead of two'),
  bool('EnableRetract', 'whether the probe retracts after a touch'),
  bool('PauseBeforeProbe', 'whether the routine pauses for confirmation before probing'),
  bool('ManualProbeMode', 'whether probing is driven by hand rather than automatically'),
  bool('Axis1CountGage', 'whether the first axis counts the gage height'),
  bool('Axis1CountDia', 'whether the first axis counts the probe diameter'),
  bool('Axis2CountGage', 'whether the second axis counts the gage height'),
  bool('Axis2CountDia', 'whether the second axis counts the probe diameter'),
]

/** The fifteen keys of that block, in order - the claim WO-1037's suite
 *  checks against the profile itself rather than against this file. */
export const PROBE_SAVED_ORDER: readonly string[] =
  PROBE_LIVE_SETTINGS.map((spec) => spec.key)

/**
 * UCCNC's saved copy of those fifteen settings for one routine.
 *
 * EVERY ELEMENT'S MEANING IS ESTABLISHED, and here is the whole of what that
 * rests on, stated so a later reader can attack it rather than trust it:
 *
 *   - The record is fifteen values on every one of the eleven rows, and the
 *     section writes exactly fifteen live settings, as one consecutive block.
 *   - The last ten are booleans in both, in the same order, and they agree BY
 *     VALUE: `Set_ToolProbe`'s ten are exactly the ten the section states
 *     live - True, False x5, True, False x3.
 *   - Elements 2-5 agree BY VALUE with `FineDistance`, `Retract`, `FastFeed`
 *     and `FineFeed` for the selected routine (`Mode=1`, Simple: 2, 0, 200,
 *     20 in both).
 *   - That leaves element 1 at the head of the same block, where the section
 *     writes `GageHeight` and nothing else.
 *
 * Element 1 was left unnamed in this order's first attempt,
 * because its value on the tool routine (3.16) is not the live `GageHeight`
 * (43). It does not need to be: `SeparateSettingsPerMode=True`, so the live
 * block is the CURRENTLY SELECTED routine's and each `Set_` row is that
 * routine's own last save - elements 2-5 differ from live on ten of the
 * eleven rows for exactly the same reason. Naming fourteen elements from the
 * block's order and refusing to name the fifteenth was not caution; it was
 * one unknown counted where the same evidence had already answered it.
 */
const probeSettingsRecord = (mode: string): ControllerSettingPart[] =>
  PROBE_LIVE_SETTINGS.map((spec) => part(
    `${spec.meaning}, as saved for the ${mode} routine`,
    spec.kind === 'boolean' ? 'boolean' : 'number',
    spec.unit,
    spec.range,
  ))

/**
 * UCCNC's saved probe-position record: seventeen slots, eight booleans and
 * nine numbers, in the order the file writes them.
 *
 * THAT ARITY AND THOSE TYPES ARE ALL THIS SOFTWARE KNOWS. The file states
 * nowhere which machine axis any slot belongs to, and UCCNC documents none of
 * them. Two of the numbers on Operator's profile (738 and 724.5) happen to equal
 * his X and Y positive soft limits, which is exactly the kind of plausible
 * reading that becomes a wrong label - so every slot here is UNNAMED until
 * UCCNC's own documentation or observed machine behaviour establishes it (a
 * follow-up line in WO-1039, never a guess here).
 */
const probePositionRecord = (): ControllerSettingPart[] => [
  ...Array.from({ length: 7 }, () => [unnamedSlot('boolean'), unnamedSlot('number')]).flat(),
  unnamedSlot('number'),
  unnamedSlot('boolean'),
  unnamedSlot('number'),
]

const PROBING_SPECS: Spec[] = [
  num('Mode', 'which probing routine is selected, as an index into UCCNC\'s own list: '
    + PROBE_MODES.join(', '), 'count', between(0, PROBE_MODES.length - 1)),
  compound('Tool', 'the saved tool-length probe move', [
    part('the routine variant UCCNC saved, as its own index', 'number', 'count'),
    ...probeLeg('for the tool length'),
  ]),
  compound('Simple', 'the saved single-surface probe move', probeLeg('')),
  compound('Angle', 'the saved two-touch angle-finding probe move', [
    ...probeLeg('first'), ...probeLeg('second'),
  ]),
  compound('Pocket', 'the saved pocket-centre probe move', probeLeg('')),
  compound('Outer', 'the saved outside-edge probe move', [
    ...probeLeg('first'), ...probeLeg('second'),
  ]),
  compound('InnerCorner', 'the saved inside-corner probe move', [
    part('the corner UCCNC saved, as its own index', 'number', 'count'),
    ...probeLeg('first'), ...probeLeg('second'),
  ]),
  compound('OuterCorner', 'the saved outside-corner probe move', [
    part('the corner UCCNC saved, as its own index', 'number', 'count'),
    ...probeLeg('first'), ...probeLeg('second'),
  ]),
  compound('RectInner', 'the saved rectangular-pocket probe move', [
    ...probeLeg('first'), ...probeLeg('second'),
  ]),
  compound('CircleInner', 'the saved bore-centre probe move', [
    ...probeLeg('first'), ...probeLeg('second'),
  ]),
  compound('RectOuter', 'the saved rectangular-boss probe move', [
    ...probeLeg('first'), ...probeLeg('second'), ...probeLeg('third'),
  ]),
  compound('CircleOuter', 'the saved round-boss probe move', [
    ...probeLeg('first'), ...probeLeg('second'), ...probeLeg('third'),
  ]),
  // The live block, declared once above and reused by the saved records so
  // the two cannot describe the same fifteen settings differently.
  ...PROBE_LIVE_SETTINGS,
  ...PROBE_MODES.map((mode) => compound(`Set_${mode}Probe`,
    `the fifteen probing settings UCCNC saved for the ${mode} routine`,
    probeSettingsRecord(mode))),
  num('SafeX', 'the machine X the probe moves to before a routine', 'units'),
  num('SafeY', 'the machine Y the probe moves to before a routine', 'units'),
  num('SafeZ', 'the machine Z the probe moves to before a routine', 'units'),
  bool('SafeXPositive', 'whether the safe X move goes positive'),
  bool('SafeYPositive', 'whether the safe Y move goes positive'),
  bool('SafeZPositive', 'whether the safe Z move goes positive'),
  bool('SaveMobileProbePos', 'whether the touch probe\'s parked position is remembered'),
  bool('SaveWpReferences', 'whether probed workpiece references are remembered'),
  bool('OverrideProbeDia', 'whether the probe diameter below replaces the tool diameter'),
  num('ProbeDiameterOvr', 'the probe tip diameter used instead of the tool diameter',
    'units', atLeast(0)),
  bool('LimitTraverseSpeed', 'whether moves during a probing routine are speed limited'),
  num('TraverseSpeedLimit', 'the speed limit applied during a probing routine', 'units/min',
    atLeast(0)),
  // Three numbers UCCNC saves for the air blast. `Blower=1,0,1` matches no
  // adjacent key triple - `BlowerPort=0`, `BlowerPin=0` and
  // `BlowerActiveLow=False` are all written separately - so the three slots
  // are typed and unnamed.
  compound('Blower', 'the saved air-blast record for clearing chips off the probe', [
    unnamedSlot('number'), unnamedSlot('number'), unnamedSlot('number'),
  ]),
  num('BlowerPort', 'the port the probe air blast is wired to', 'port', atLeast(0)),
  num('BlowerPin', 'the pin the probe air blast is wired to', 'pin', atLeast(0)),
  bool('BlowerActiveLow', 'whether the probe air blast output is inverted'),
  bool('SeparateSettingsPerMode', 'whether each routine keeps its own saved settings '
    + 'instead of sharing one set'),
  compound('FixedProbePos', 'the saved position of the fixed tool setter',
    probePositionRecord()),
  compound('MobileProbePos', 'the saved parked position of the touch probe',
    probePositionRecord()),
  compound('InfoWindowPos', 'where UCCNC last left its probing information window', [
    part('the window\'s left edge, in screen pixels', 'number', 'count'),
    part('the window\'s top edge, in screen pixels', 'number', 'count'),
  ]),
]

const FAULT_SIGNAL_SPECS: Spec[] = [
  ...table('Fault signals', 15, (index) => [
    bool(`Enable${index}`, `whether fault signal ${index} is watched`),
    num(`Port${index}`, `the port fault signal ${index} is wired to`, 'port', atLeast(0)),
    num(`Pin${index}`, `the pin fault signal ${index} is wired to`, 'pin', atLeast(0)),
    bool(`ActiveLow${index}`, `whether fault signal ${index} reads asserted when low`),
    text(`Description${index}`, `what fault signal ${index} is called on screen`),
    text(`Action${index}`, `what UCCNC does when fault signal ${index} trips, under `
      + 'UCCNC\'s own name for the action'),
    num(`StartDelay${index}`, `how long fault signal ${index} is ignored for after a `
      + 'cycle starts', 'ms', atLeast(0)),
    num(`ActionDelay${index}`, `how long fault signal ${index} must hold before the `
      + 'action runs', 'ms', atLeast(0)),
    num(`LED${index}`, `the screen LED fault signal ${index} lights, as UCCNC's own `
      + 'code', 'count', atLeast(0)),
    bool(`Invert${index}`, `whether fault signal ${index}'s screen LED is inverted`),
  ]),
  bool('MsgBoxOnWarning', 'whether a fault set to warn also opens a message box'),
]

/** UCCNC's simplified VFD page. Several of its values are REGISTER ADDRESSES
 *  AND RAW FRAMES WRITTEN AS HEX with their leading zeros - `0006`, `0000`,
 *  `0106100000054d09`. Reading those as numbers loses the leading zeros and
 *  the frame, so they are text, which is their real type. */
const MODBUS_EZ_SPECS: Spec[] = [
  bool('MultiBM', 'whether the simplified VFD page drives multiple registers'),
  bool('RpmONLY', 'whether only the speed register is written'),
  bool('MultipleRegs', 'whether speed is written with a multiple-register write'),
  bool('MultiCoil', 'whether run and direction are written with a multiple-coil write'),
  bool('SingCoil', 'whether run and direction are written with a single-coil write'),
  bool('HZ Range', 'whether the drive is commanded in hertz rather than in RPM'),
  bool('SingHold', 'whether speed is written with a single holding-register write'),
  bool('Amp Enable', 'whether the spindle load current is read back'),
  text('Selectedport', 'the serial port the VFD is on'),
  num('SelectedBaud', 'the serial speed the VFD is talked to at', 'baud', atLeast(0)),
  choice('StopBit', 'how many stop bits the VFD link uses',
    ['One', 'OnePointFive', 'Two']),
  text('CaDD', 'the register address the drive\'s capacity is read from, in hex'),
  text('FrqADD', 'the register address the speed command is written to, in hex'),
  text('ONCW', 'the command value that runs the spindle clockwise, in hex'),
  text('ONCCW', 'the command value that runs the spindle counter-clockwise, in hex'),
  text('STOP', 'the command value that stops the spindle, in hex'),
  num('Function', 'the Modbus function code used to write the drive', 'count', atLeast(0)),
  text('DisplayField', 'what the page shows in its readout'),
  text('SpindleStop', 'the whole Modbus frame sent to stop the spindle, in hex'),
  text('SendCwOn', 'the whole Modbus frame sent to run the spindle clockwise, in hex'),
  text('SendCwwOn', 'the whole Modbus frame sent to run the spindle counter-clockwise, '
    + 'in hex'),
  text('Amp Address', 'the register address the spindle load current is read from, in hex'),
  num('Amp Divideby', 'what the raw load-current reading is divided by', 'ratio',
    atLeast(0)),
  num('SelectedFreq', 'the drive\'s base frequency at full speed', 'hz', atLeast(0)),
  num('Selectedminrpm', 'the slowest speed the drive is asked for', 'rpm', atLeast(0)),
  num('Selectedmaxrpm', 'the fastest speed the drive is asked for', 'rpm', atLeast(0)),
  text('Amp Send', 'the whole Modbus frame sent to read the spindle load current, in hex'),
]

const MODBUS_CONNECTION_SPECS: Spec[] = [
  text('Description', 'what this Modbus connection is called'),
  num('ID', 'this connection\'s own index', 'count', atLeast(0)),
  bool('Enabled', 'whether this Modbus connection runs'),
  num('Loopinterval', 'how often this connection polls', 'ms', atLeast(0)),
  num('Retrycount', 'how many times a failed exchange is retried', 'count', atLeast(0)),
  num('Timeout', 'how long a reply is waited for', 'ms', atLeast(0)),
  choice('Type', 'which Modbus transport this connection uses', ['RTU', 'ASCII', 'TCP']),
  num('Serial_Baudrate', 'the serial speed of this connection', 'baud', atLeast(0)),
  text('Serial_Comport', 'the serial port of this connection'),
  num('Serial_Databits', 'how many data bits each serial character has', 'count',
    between(5, 8)),
  choice('Serial_Parity', 'the serial parity of this connection',
    ['None', 'Odd', 'Even', 'Mark', 'Space']),
  bool('Serial_RS485mode', 'whether the port is driven as half-duplex RS485'),
  num('Serial_Stopbits', 'how many stop bits each serial character has', 'count',
    between(1, 2)),
  ...table('Functions', 4, (index) => [
    text(`Function_${index - 1}`,
      `the section naming Modbus exchange ${index - 1} on this connection`),
  ]),
]

/** UCCNC's own names for a Modbus exchange. */
const MODBUS_FUNCTION_TYPES = [
  'Read_Coils', 'Read_DiscreteInputs', 'Read_HoldingRegisters', 'Read_InputRegisters',
  'Write_SingleCoil', 'Write_SingleRegister', 'Write_MultipleCoils',
  'Write_MultipleRegisters',
] as const

const modbusFunctionSpecs = (): Spec[] => [
  text('Name', 'what this Modbus exchange is called'),
  bool('Enabled', 'whether this Modbus exchange runs'),
  choice('Type', 'which Modbus read or write this exchange performs',
    MODBUS_FUNCTION_TYPES),
  num('Registercount', 'how many registers or coils this exchange covers', 'count',
    atLeast(0)),
  num('Slaveaddress', 'the Modbus address of the device this exchange talks to', 'count',
    between(0, 247)),
  num('Startregister', 'the first register or coil on the device, in decimal', 'count',
    atLeast(0)),
  num('UCCNCstartregister', 'the first UCCNC register this exchange maps to', 'count',
    atLeast(0)),
]

const INPUT_TRIGGER_SPECS: Spec[] = table('Input triggers', 96, (index) => [
  num(`Port${index}`, `the port input trigger ${index} watches`, 'port', atLeast(0)),
  num(`Pin${index}`, `the pin input trigger ${index} watches`, 'pin', atLeast(0)),
  num(`Buttoncode${index}`, `the screen button input trigger ${index} presses, as `
    + 'UCCNC\'s own code', 'count', atLeast(0)),
  bool(`Activelow${index}`, `whether input trigger ${index} fires when the pin goes low`),
])

const OUTPUT_TRIGGER_SPECS: Spec[] = table('Output triggers', 96, (index) => [
  num(`Port${index}`, `the port output trigger ${index} drives`, 'port', atLeast(0)),
  num(`Pin${index}`, `the pin output trigger ${index} drives`, 'pin', atLeast(0)),
  num(`LEDcode${index}`, `the screen LED output trigger ${index} follows, as UCCNC's `
    + 'own code', 'count', atLeast(0)),
  bool(`Invert${index}`, `whether output trigger ${index} drives its pin inverted`),
])

const MACRO_LOOP_SPECS: Spec[] = table('Macro loops', 48, (index) => [
  bool(`Macroloopautorun${index}`, `whether macro loop slot ${index} runs continuously`),
  num(`Macroloopnumber${index}`, `the macro number macro loop slot ${index} runs`, 'count',
    atLeast(0)),
], 0)

const LASER_SPECS: Spec[] = [
  num('workpiecewidth', 'the width of the area the laser engraves', 'units', atLeast(0)),
  num('workpieceheight', 'the height of the area the laser engraves', 'units', atLeast(0)),
  bool('keepaspectratio', 'whether the image keeps its proportions inside that area'),
  num('Yscandistance', 'the distance between engraved scan lines', 'units', atLeast(0)),
  num('Feedrate', 'the speed the laser scans at', 'units/min', atLeast(0)),
  num('Originsetting', 'which corner or centre of the image the origin is, as UCCNC\'s '
    + 'own code', 'count', atLeast(0)),
]

const RFH_SPECS: Spec[] = [
  num('Switchspindlemode', 'how the rigid-tapping plugin switches the spindle, as '
    + 'UCCNC\'s own code', 'count', atLeast(0)),
  bool('Doinitialmoveswithrapid', 'whether the plugin\'s approach moves run at rapid'),
]

/**
 * EVERY SETTING A UCCNC MACHINE HAS, TYPED.
 *
 * Ordered as UCCNC orders its own file, so a reader with the profile open can
 * follow both at once.
 */
export const UCCNC_SETTING_FIELDS: readonly ControllerSettingField[] = [
  ...PROFILE_AXES.flatMap((axis) => section(axisSection(axis), axisSpecs(axis))),
  ...section('Spindlesetupsettings', SPINDLE_SPECS),
  ...section('Generalsettings', GENERAL_SPECS),
  ...section('IOsetupsettings', IO_SPECS),
  ...section('SpindlePIDsettings', SPINDLE_PID_SPECS),
  ...section('AUXencodersettings', AUX_ENCODER_SPECS),
  ...section('Digitizesettings', DIGITIZE_SPECS),
  ...section('Probing', PROBING_SPECS),
  ...section('FaultSignals', FAULT_SIGNAL_SPECS),
  ...section('ModbusEZ', MODBUS_EZ_SPECS),
  ...section('Modbus_connection_0', MODBUS_CONNECTION_SPECS),
  ...section('Modbus_function_0_0', modbusFunctionSpecs()),
  ...section('Modbus_function_0_1', modbusFunctionSpecs()),
  ...section('Modbus_function_0_2', modbusFunctionSpecs()),
  ...section('Modbus_function_0_3', modbusFunctionSpecs()),
  ...section('Inputtriggersettings', INPUT_TRIGGER_SPECS),
  ...section('Outputtriggersettings', OUTPUT_TRIGGER_SPECS),
  ...section('Macroloops', MACRO_LOOP_SPECS),
  ...section('Laserengraveplugin', LASER_SPECS),
  ...section('RFHsettings', RFH_SPECS),
]

const FIELD_BY_KEY = new Map(
  UCCNC_SETTING_FIELDS.map((field) => [field.key.toLowerCase(), field] as const),
)

/** The model for one `Section.Key`, or undefined when this software has none.
 *  Case-insensitive, because a `.pro` is and the unsent set already is. */
export const uccncSettingField = (key: string): ControllerSettingField | undefined =>
  FIELD_BY_KEY.get(key.toLowerCase())

/** WHOSE VOCABULARY THIS CATALOGUE SPEAKS. Every key in `UCCNC_SETTING_FIELDS`
 *  is a UCCNC `.pro` key and means nothing on any other controller, so this is
 *  the controller a machine must BE before one of them may be stored on it. */
export const UCCNC_CATALOGUE_CONTROLLER: ControllerType = 'uccnc'

/** A catalogued write that happened, or the refusal and its reason. Never a
 *  bare array: a caller that cannot tell a stored value from a refused one is
 *  how a silent store gets written. */
export type CataloguedSettingWrite =
  | { ok: true; settings: ControllerSetting[] }
  | { ok: false; refused: string }

/**
 * STORE ONE CATALOGUED `.pro` SETTING ON A MACHINE THAT IS ACTUALLY A UCCNC
 * MACHINE - the one write path for the 1489 keys this catalogue names
 * (WO-1039, audit round 6).
 *
 * THE DEFECT THIS CLOSES. The definition page built its setting source with
 * `controller: draft.controller` and `field: uccncSettingField` - the MACHINE'S
 * identity paired with UCCNC'S catalogue. On a GRBL, LinuxCNC or generic
 * machine the generic boxes therefore accepted a key like
 * `Generalsettings.Lookaheadlines` and stored it as
 * `{ controller: 'grbl', key: 'Generalsettings.Lookaheadlines' }`: a UCCNC
 * setting wearing another controller's name, on a record whose exporter and
 * bridge have no idea what it is. That is the identity-blindness WO-1024 names,
 * and a definition that carries it is a definition of no real machine.
 *
 * IT IS A REFUSAL, NOT A NO-OP. The page above this already draws no catalogue
 * box on a machine that is not a UCCNC machine, so nothing a person can click
 * reaches here; this is the second half of the same rule, kept HERE so the
 * first half cannot be bypassed by a caller that never asked the page. The
 * reason comes back as text because the caller owes the user a console line -
 * a write that vanishes without one is the silent store in a different coat.
 *
 * `null` REMOVES, exactly as `withControllerSetting` does, and is refused on a
 * non-UCCNC machine for the same reason a set is: a machine that may not hold
 * these keys has none to take back off, and answering "removed" would be this
 * function agreeing it ever could.
 */
export function withUccncCataloguedSetting(
  settings: readonly ControllerSetting[] | undefined,
  machine: ControllerType,
  key: string,
  value: ControllerSettingValue | null,
): CataloguedSettingWrite {
  const refused = uccncCatalogueRefusal(machine, key)
  if (refused !== null) return { ok: false, refused }
  const written = withControllerSetting(settings, machine, key, value)
  const appKey = axisDriveAppKey(key)
  return {
    ok: true,
    settings: appKey === undefined
      ? written
      : written.map((entry) => (
        entry.controller === machine && entry.key.toLowerCase() === key.toLowerCase()
          ? { ...entry, appKey }
          : entry
      )),
  }
}

/** WHY THIS MACHINE MAY NOT BE TOLD THIS KEY, or null when it may. The same
 *  rule `withUccncCataloguedSetting` enforces, asked without a write, so a
 *  caller can say the reason before it has a value to store. */
export function uccncCatalogueRefusal(machine: ControllerType, key: string): string | null {
  if (machine === UCCNC_CATALOGUE_CONTROLLER) return null
  return `${key} is a UCCNC profile setting and this machine is a ${machine} `
    + 'machine. It was not stored - a setting is only ever kept in the vocabulary '
    + 'of the controller that has it.'
}

/** UCCNC writes booleans as `True`/`False`. Its own vocabulary, not ours. */
const UCCNC_TRUE = 'True'
const UCCNC_FALSE = 'False'

type ParsedValue =
  | { ok: true; value: ControllerSettingValue }
  | { ok: false; message: string }

function parseScalar(
  spec: { kind: Exclude<ControllerSettingKind, 'tuple'>; options: readonly string[] | null },
  raw: string,
): { ok: true; value: ControllerSettingScalar } | { ok: false; message: string } {
  if (spec.kind === 'text') return { ok: true, value: { kind: 'text', value: raw } }
  if (spec.kind === 'enum') {
    // An unlisted member is CARRIED, not refused. `options` is the vocabulary
    // this software knows; a newer UCCNC may write one it does not, and
    // dropping the machine's own value over that would be the invention this
    // whole model exists to remove.
    return { ok: true, value: { kind: 'enum', value: raw } }
  }
  if (spec.kind === 'boolean') {
    const lower = raw.toLowerCase()
    if (lower === 'true' || lower === '1') return { ok: true, value: { kind: 'boolean', value: true } }
    if (lower === 'false' || lower === '0') return { ok: true, value: { kind: 'boolean', value: false } }
    return { ok: false, message: `expected True or False, found "${raw}"` }
  }
  // `Number('')` is 0, which would turn a blank into a machine fact.
  if (raw.trim() === '') return { ok: false, message: 'expected a number, found nothing' }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return { ok: false, message: `expected a number, found "${raw}"` }
  }
  return { ok: true, value: { kind: 'number', value: parsed } }
}

/**
 * Read one key's text into its modelled value.
 *
 * NEVER GUESSES. A value that does not fit its model is refused with a reason
 * and the key stays unmodelled, because a substituted default is exactly the
 * defect the machine definition exists to prevent.
 */
export function parseUccncSettingValue(
  field: ControllerSettingField, raw: string,
): ParsedValue {
  if (field.kind !== 'tuple') {
    return parseScalar({ kind: field.kind, options: field.options }, raw)
  }
  const parts = field.parts ?? []
  const pieces = raw.split(',').map((piece) => piece.trim())
  if (pieces.length !== parts.length) {
    return {
      ok: false,
      message: `expected ${parts.length} comma-separated values, found ${pieces.length} `
        + `in "${raw}"`,
    }
  }
  const values: ControllerSettingScalar[] = []
  for (let index = 0; index < parts.length; index++) {
    const parsed = parseScalar(parts[index], pieces[index])
    if (!parsed.ok) return { ok: false, message: `element ${index + 1}: ${parsed.message}` }
    values.push(parsed.value)
  }
  return { ok: true, value: { kind: 'tuple', value: values } }
}

const formatScalar = (value: ControllerSettingScalar): string => {
  if (value.kind === 'boolean') return value.value ? UCCNC_TRUE : UCCNC_FALSE
  if (value.kind === 'number') return String(value.value)
  return value.value
}

/**
 * Write one modelled value back in UCCNC's own spelling.
 *
 * The exporter (WO-1038) is the caller this exists for, and the round trip is
 * the ruler ADR-0044 Amendment 1 describes: content-identical, not
 * byte-identical. A number comes back in JavaScript's spelling of it, which is
 * the same VALUE and not always the same characters - `0006` is not a number
 * here for exactly that reason, it is text, and stays text.
 */
export function formatUccncSettingValue(value: ControllerSettingValue): string {
  if (value.kind === 'tuple') return value.value.map(formatScalar).join(',')
  return formatScalar(value)
}

/**
 * ONE PASS OVER THE MACHINE SECTIONS, THREE HONEST ANSWERS.
 *
 * Run AFTER all reading, never during: a key read later in the pass would
 * otherwise be reported as a gap. The order of operations is the correctness
 * condition here, so the one call site is at the very end of
 * `importUccncProfile`, immediately before the return.
 *
 * `settings` and `unsent` are now DISJOINT, and one pass is what keeps them
 * that way. Every machine-describing key no purpose-built reader asked for
 * goes to exactly one of them:
 *
 *   `settings` the fact TYPED, on the DEFINITION
 *              (`ControllerDefinition.settings`) - the record WO-1039 edits
 *              and WO-1038 exports. This is where a key goes when it can.
 *   `unsent`   the machine's own text, for a key the typed model could not
 *              take: no model, or a value that would not parse against the
 *              model it has. WO-947's container, kept because a value we
 *              cannot model is still a fact about somebody's machine.
 *
 * They were the SAME 1489 keys for a day - WO-1037 landed the types while the
 * definition page could still read nothing but the text - and that is why the
 * split is decided here, in the one loop, rather than by two functions that
 * would have to agree. A key cannot appear in both, and cannot fall out of
 * both, without this branch being wrong in a way a reader can see.
 *
 * Wiring a setting into a purpose-built field means calling `rawOf` for it,
 * and that one edit drops the key out of this pass entirely.
 */
interface CollectedSettings {
  settings: ControllerSetting[]
  unsent: UnsentSetting[]
  unmodelled: string[]
}

function collectSettings(
  sections: Map<string, Section>,
  issues: ProfileImportIssue[],
): CollectedSettings {
  const settings: ControllerSetting[] = []
  const unsent: UnsentSetting[] = []
  const unmodelled: string[] = []

  for (const wanted of CONFIG_SECTIONS) {
    const s = sections.get(wanted.toLowerCase())
    if (!s) continue
    for (const [lower, entry] of s.values) {
      if (s.read.has(lower)) continue
      const key = `${s.name}.${entry.key}`
      // `uccnc` is this importer's whole subject, so it is a constant here
      // rather than a parameter. A GRBL definition reader would push
      // `{ controller: 'grbl', key: '$130' }` into the same containers.
      //
      // WHAT PUTS A KEY IN `unsent` NOW, AND WHY IT CHANGED (WO-1039).
      //
      // It used to be EVERY key no purpose-built reader consumed - 1489 of
      // Operator's 1680 - which made `unsent` a verbatim-text twin of the typed
      // group beside it. Two records of one machine fact is the defect this
      // repository has lost the most evenings to, and it was only tolerable
      // while the definition page could read nothing else.
      //
      // It is now the LAST RESORT: a key lands here when this software has no
      // model for it, or when it has one and this machine's value would not
      // parse against it. Either way the typed group cannot hold the value and
      // dropping it would lose a machine fact, so the controller's own text is
      // kept. Everything else is on `ControllerDefinition.settings`, typed,
      // where the definition page edits it and Apply carries it.
      //
      // The consequence is the measurement: `tools/pro-coverage.mjs` computes
      // SENDABLE as "not in `unsent`", so an empty `unsent` on Operator's profile
      // IS the 1680-of-1680 claim, and any key this software cannot model
      // subtracts itself from that number automatically.
      const unreadable = (message: string): void => {
        unsent.push({ controller: 'uccnc', key, value: entry.value })
        if (message !== '') issues.push({ key, message })
      }

      const field = uccncSettingField(key)
      if (!field) {
        unmodelled.push(key)
        unreadable('')
        continue
      }
      const parsed = parseUccncSettingValue(field, entry.value)
      if (!parsed.ok) {
        // A value that does not fit its model is a READ that failed, which is
        // what `issues` is for. It is not reported as unmodelled as well: the
        // model exists, this machine's value did not match it, and counting
        // one defect in two registers is how a hitlist starts lying.
        unreadable(parsed.message)
        continue
      }
      // THE CATALOGUE'S SPELLING GOES ON THE DEFINITION, not the file's.
      //
      // A `.pro` is case-insensitive and this parser is too - `sections` and
      // `values` are both keyed lower-cased - so `key` here is whatever case
      // THIS file happened to use. `[GENERALSETTINGS] softlimitsenable=True`
      // describes exactly the same machine as `[Generalsettings]
      // Softlimitsenable=True`, and the field it lands in is the same field.
      //
      // Storing the file's spelling made the typed group reachable only by a
      // consumer that had already read this particular file. A consumer
      // walking `UCCNC_SETTING_FIELDS` - which is every reader this model
      // exists for, the panel of WO-1039 and the exporter of WO-1038 - asks
      // with `field.key`, and got absence for a value that was right there.
      // `field.key` is the one spelling both ends agree on.
      //
      // `unsent` above keeps the file's own text, because that container's job
      // (WO-947) is to carry the machine's own words, not the catalogue's.
      settings.push({ controller: 'uccnc', key: field.key, value: parsed.value })
    }
  }
  return { settings, unsent, unmodelled }
}

/**
 * Phase B's cached startup state. These 18 values travel in the definition,
 * but deliberately do not enter UCCNC_SETTING_FIELDS: the Offsets panel owns
 * them, while that catalogue drives the generic configuration editor and
 * exporter. Making them catalogue fields would create a second owner and let
 * config export overwrite live offset state.
 */
function collectStartupWorkOffsets(
  sections: Map<string, Section>,
  issues: ProfileImportIssue[],
): ControllerSetting[] {
  const settings: ControllerSetting[] = []
  for (const sectionName of WORK_OFFSET_SECTIONS) {
    const section = sections.get(sectionName.toLowerCase())
    if (!section) continue
    for (const keyName of WORK_OFFSET_KEYS) {
      const entry = section.values.get(keyName.toLowerCase())
      if (!entry) continue
      const key = `${sectionName}.${keyName}`
      const raw = entry.value.trim()
      const value = Number(raw)
      if (raw === '' || !Number.isFinite(value)) {
        issues.push({
          key,
          message: raw === ''
            ? 'expected a number, found nothing'
            : `expected a number, found "${entry.value}"`,
        })
        continue
      }
      settings.push({ controller: 'uccnc', key, value: { kind: 'number', value } })
    }
  }
  return settings
}

/** Backwards-compatible importer name for the canonical definition carrier. */
export type ProfileImportIssue = ControllerImportIssue

export interface ProfileImportResult {
  /** Null when the text is not a profile at all - see `issues`. */
  definition: ControllerDefinition | null
  /** Machine-level facts the definition does not carry, for MachineConfig. */
  travel: { x: number; y: number; z: number } | null
  /** App-owned machine-coordinate fact decoded from Probing.FixedProbePos. */
  toolSetter: Partial<Vec3> | null
  /** App-owned board identity decoded from Statistics.UCdevicetype. */
  controllerBoard: MachineControllerBoard | null
  /** What UCCNC calls this profile, when it says. */
  profileName: string | null
  /**
   * Everything we could not read, NAMED. Never thrown away and never
   * summarised into a count: an importer that silently defaults a pin is how
   * a machine ends up commanded through a wire nobody assigned.
   */
  issues: ProfileImportIssue[]
  /**
   * THE KEYS THE TYPED MODEL COULD NOT TAKE, carrying the machine's own value
   * AS TEXT so nothing this file said is lost (WO-947, narrowed by WO-1039).
   *
   * EMPTY IS THE GOAL AND EMPTY IS THE MEASUREMENT. Every machine-describing
   * key this software models and can parse is on `definition.settings`, typed,
   * which is the record ADR-0044 requirement 5 measures and the record the
   * definition page now edits. A key is here only when that failed:
   *
   *   no model      nothing in this software knows what the key is; it is in
   *                 `unmodelled` as well, which is the register for that.
   *   would not parse   the model exists and this machine's value does not fit
   *                 it; the reason is in `issues`, which is the register for
   *                 that.
   *
   * So this is not a second copy of anything - a key here is one the typed
   * group does NOT hold. It was a verbatim twin of 1489 typed keys for about a
   * day (WO-1037 landed the types, WO-1039 the read sites), and that overlap is
   * gone rather than documented.
   *
   * Operator's profile produces NONE of these, which is what makes
   * `tools/pro-coverage.mjs` report SENDABLE 1680 of 1680: that number is
   * "keys not in this list", so a key this software cannot model subtracts
   * itself from the completeness claim without anybody maintaining a list.
   */
  unsent: UnsentSetting[]
  /**
   * Machine-describing keys this software HAS NO MODEL FOR - it cannot say
   * what they mean, what unit they are in or what they will accept.
   *
   * The third of three registers, and the three answer three different
   * questions about the same key:
   *
   *   `issues`     we tried to read it and could not.
   *   `unsent`     nothing in this software can carry it to the machine.
   *   `unmodelled` nothing in this software knows what it is.
   *
   * Named, never counted, and never silently dropped: a key with no model
   * is the gap ADR-0044 requirement 5 is measured by, and an importer that
   * swallowed it would report a complete machine definition that is not
   * one. Empty for Operator's profile, which is the completeness claim this
   * order makes.
   */
  unmodelled: string[]
}

/**
 * One `[Section]` of the profile, and A RECORD OF WHICH KEYS WE ACTUALLY READ.
 *
 * The read-set is what makes WO-947's hitlist an exact measurement rather than
 * an estimate. `tools/pro-coverage.mjs` has to approximate this from OUTSIDE,
 * by scanning this file for quoted key names, and states that honest limit
 * itself: it cannot see a key assembled at runtime, and it counts a key that
 * is mentioned but discarded. From in here there is nothing to approximate -
 * a key was asked for or it was not.
 *
 * That matters because the alternative is a hand-kept list of "settings we
 * cannot send yet", and such a list starts lying the first time somebody wires
 * one and forgets to strike it off. Here, wiring a setting means calling
 * `rawOf` for it, which drops it out of the unsent set IN THE SAME EDIT.
 */
interface Section {
  /** The header's own spelling, e.g. `axessettingscontrolX`. */
  name: string
  /** lowercased key -> the key's own spelling and its verbatim value. */
  values: Map<string, { key: string; value: string }>
  /** Lowercased keys some reader asked for, parsed or not. */
  read: Set<string>
}

/**
 * A value the imported file carries outside the catalogue LienCAM uses.
 *
 * These are a read-only snapshot of UCCNC's own application state - screen
 * set, appearance, hotkeys, messages, CAM preferences, plugins, statistics,
 * live coordinates and tool table. They stay on the imported definition so
 * All settings can honestly show the whole file, but they never enter
 * `settings`, `unsent`, exported controller values, or any machine decision.
 */
/** The imported values that are not in LienCAM's one UCCNC catalogue. */
export function uccncProfileOnlySettings(
  definition: ControllerDefinition | null | undefined,
): readonly ControllerProfileOnlySetting[] {
  return definition?.profileOnlySettings?.filter((setting) => setting.controller === 'uccnc') ?? []
}

/**
 * Derive "not used by LienCAM" from the catalogue itself. There is no second
 * section list to maintain: adding a key to UCCNC_SETTING_FIELDS removes that
 * exact key from this read-only collection on the next import.
 */
function collectProfileOnlySettings(sections: Map<string, Section>): ControllerProfileOnlySetting[] {
  const settings: ControllerProfileOnlySetting[] = []
  for (const section of sections.values()) {
    for (const entry of section.values.values()) {
      if (FIELD_BY_KEY.has(`${section.name}.${entry.key}`.toLowerCase())) continue
      settings.push({ controller: 'uccnc', section: section.name, key: entry.key, value: entry.value })
    }
  }
  return settings
}

/**
 * `.pro` is INI-shaped: `[Section]` then `Key=Value`. Parsed permissively -
 * blank lines, `;`/`#` comments and stray whitespace are all real in files
 * UCCNC has written - but never GUESSED: an unreadable value becomes an issue,
 * not a default.
 */
function parseIni(text: string): Map<string, Section> {
  const sections = new Map<string, Section>()
  let current: Section | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      const name = header[1].trim()
      current = { name, values: new Map(), read: new Set() }
      sections.set(name.toLowerCase(), current)
      continue
    }
    if (!current) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    current.values.set(key.toLowerCase(), { key, value: line.slice(eq + 1).trim() })
  }
  return sections
}

/**
 * Decode UCCNC's profile spelling into the one DeviceInfo identity used by
 * MachineConfig and the bridge. Numeric positive values are already that
 * identity, including values newer than this app's name table. Named values
 * go through the one controller-board reverse lookup; AXBB is UCCNC's legacy
 * profile spelling for the vendor name AXBB-E.
 */
function readUccncBoardDeviceType(
  sections: Map<string, Section>,
  log: ReadLog,
): MachineControllerBoard | null {
  const raw = rawOf(sections.get('statistics'), 'UCdevicetype')
  if (raw === undefined) return null
  const value = raw.trim()
  const numeric = Number(value)
  if (value !== '' && Number.isInteger(numeric) && numeric >= 1) {
    return { deviceType: numeric }
  }

  const profileName = /^AXBB$/i.test(value) ? 'AXBB-E' : value
  const named = uccncBoardDeviceTypeByName(profileName)
  if (named !== null) return { deviceType: named }

  log.issues.push({
    key: 'Statistics.UCdevicetype',
    message: value === ''
      ? 'expected a positive DeviceInfo type or board name, found nothing'
      : `expected a positive DeviceInfo type or board name, found "${raw}"`,
  })
  return null
}

/** Read one key AND record that we asked for it - see `Section.read`.
 *
 *  The recording happens on ASK, not on success. A key this software tried to
 *  read and could not parse is a key it KNOWS ABOUT: it already produces a
 *  named `ProfileImportIssue`, and reporting it as an unsurfaced gap as well
 *  would count one defect twice in two different registers. */
const rawOf = (s: Section | undefined, key: string): string | undefined => {
  if (!s) return undefined
  const k = key.toLowerCase()
  s.read.add(k)
  return s.values.get(k)?.value
}

/** Hand a key BACK to `collectSettings` - the exact opposite of `rawOf`.
 *
 *  A reader that consumes a key and then throws its value away is worse than
 *  one that never touched it: the key is missing from `settings` AND the field
 *  that claimed it disagrees with the file. Releasing it restores the only
 *  honest carriage left - the machine's own text, in the definition's own
 *  settings group. Used where a raw value is resolved into something that
 *  cannot produce it again (`readPin`). */
const release = (s: Section | undefined, key: string): void => {
  s?.read.delete(key.toLowerCase())
}

/**
 * WHAT A READER WRITES BACK BESIDES THE VALUE.
 *
 * `issues` is what went wrong. `stated` is the quieter half and the one
 * WO-1037 exists for: which keys the profile ACTUALLY SAID. A purpose-built
 * field is a plain `number`, so an omitted `Softlimitpositive` becomes a 0
 * this software chose and the definition then states it as confidently as it
 * states 738. Recording the statement separately makes "the profile did not
 * say" and "the profile said this default" two different facts, without
 * making 191 fields nullable and every consumer of an axis check them.
 */
interface ReadLog {
  issues: ProfileImportIssue[]
  stated: ControllerSettingRef[]
}

/**
 * Record that the profile STATED this key, in the catalogue's own spelling.
 *
 * Called only where a value was both present and understood. A key the file
 * omits is not stated; neither is one whose value did not parse - a number
 * this software could not read is a number this machine has not successfully
 * told us, and the field falls back to a default exactly as if the key were
 * missing. The suite asserts every key recorded here resolves in the
 * catalogue, so a reader that spells a key differently from the catalogue
 * fails loudly instead of recording provenance nobody can look up.
 */
const state = (log: ReadLog, section: string, key: string): void => {
  log.stated.push({ controller: 'uccnc', key: `${section}.${key}` })
}

/** UCCNC writes `True`/`False`. Anything else is reported, not assumed.
 *
 *  The fallback's own type comes back out, so a caller that has no honest
 *  default passes `null` and gets `null` for an absent or unreadable key
 *  rather than a fabricated `false`. */
function readBool<F extends boolean | null>(
  s: Section | undefined, section: string, key: string,
  fallback: F, log: ReadLog,
): boolean | F {
  const raw = rawOf(s, key)
  if (raw === undefined) return fallback
  const v = raw.toLowerCase()
  if (v === 'true' || v === '1') { state(log, section, key); return true }
  if (v === 'false' || v === '0') { state(log, section, key); return false }
  log.issues.push({ key: `${section}.${key}`, message: `expected True or False, found "${raw}"` })
  return fallback
}

/**
 * What a numeric read FOUND, before anybody decides whether the definition can
 * give it back.
 *
 * `stated` is true when the profile supplied a number this reader understood -
 * the precondition for recording the key. It is not the whole condition: a
 * reader that parses a value and then RESOLVES IT AWAY (`readPin` collapsing a
 * half-assigned wire) holds a definition that can no longer produce it, and
 * marking the key stated would claim otherwise. Splitting the scan from the
 * statement is what lets that caller decide.
 */
interface ScannedNumber {
  value: number
  stated: boolean
}

function scanNum(
  s: Section | undefined, section: string, key: string,
  fallback: number, log: ReadLog,
): ScannedNumber {
  const raw = rawOf(s, key)
  if (raw === undefined) return { value: fallback, stated: false }
  // `Number('')` is 0 and `Number.isFinite(0)` is true, so a blank assignment
  // would sail through as the machine saying zero and get RECORDED as stated.
  // A key written with nothing after the `=` has supplied no number; it is
  // reported and falls back exactly like `banana`, which is also the refusal
  // the catalogue parser makes for the same text (parseScalar, and its
  // message, so the two containers cannot disagree about one blank).
  if (raw.trim() === '') {
    log.issues.push({ key: `${section}.${key}`, message: 'expected a number, found nothing' })
    return { value: fallback, stated: false }
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    log.issues.push({ key: `${section}.${key}`, message: `expected a number, found "${raw}"` })
    return { value: fallback, stated: false }
  }
  return { value: n, stated: true }
}

/** A number that lands in a field of its own, so understanding it IS holding
 *  it and the key can be stated on the spot. */
function readNum(
  s: Section | undefined, section: string, key: string,
  fallback: number, log: ReadLog,
): number {
  const read = scanNum(s, section, key, fallback, log)
  if (read.stated) state(log, section, key)
  return read.value
}

/**
 * A pin is a PAIR and it is only meaningful whole. UCCNC writes port 0 / pin 0
 * for "not assigned", which is what `UNASSIGNED_PIN` already means and what the
 * UC100 API itself treats as unassigned (types/index.ts:205-208), so the two
 * agree without a translation table.
 */
function readPin(
  s: Section | undefined, section: string,
  portKey: string, pinKey: string, negateKey: string,
  log: ReadLog,
): PinRef {
  const port = scanNum(s, section, portKey, 0, log)
  const pin = scanNum(s, section, pinKey, 0, log)
  if (port.value > 0 && pin.value > 0) {
    if (port.stated) state(log, section, portKey)
    if (pin.stated) state(log, section, pinKey)
    // A negate key the profile does not carry has not told us this pin's
    // polarity, and `false` would say it did. Absent reads `null` - unknown -
    // and only a key that actually says True/False produces a polarity.
    return { port: port.value, pin: pin.value, negate: readBool(s, section, negateKey, null, log) }
  }

  if ((port.value > 0) !== (pin.value > 0)) {
    log.issues.push({
      key: `${section}.${portKey}/${pinKey}`,
      message: `incomplete pin pair (${port.value}, ${pin.value}) - both port and pin are required; `
        + 'the definition leaves this signal unassigned',
    })
  }

  // THE PAIR COLLAPSES - AND A NUMBER STANDING BESIDE THE ZERO WOULD COLLAPSE
  // WITH IT. `Stepportnumber=7` next to `Steppinnumber=0` is an unassigned
  // wire whose PORT the file still names. Both keys used to be recorded as
  // stated, so the definition claimed it could give back a 7 that no longer
  // existed anywhere in it (audit 2026-08-26T23:39Z).
  //
  // A zero IS what the collapsed pin holds, so stating that key is honest. A
  // non-zero is not, so the key goes BACK to `collectSettings`, where the
  // machine's own number is carried verbatim and the key states itself by
  // being there. Either way the definition can produce what the file said.
  for (const [read, key] of [[port, portKey], [pin, pinKey]] as const) {
    if (!read.stated) continue
    if (read.value === 0) state(log, section, key)
    else release(s, key)
  }
  // The negate key is left unread for the same reason: an unassigned pin has
  // no polarity field to hold a polarity in, so `settings` keeps it.
  return { ...UNASSIGNED_PIN }
}

function readAxis(
  sections: Map<string, Section>, axis: AxisName, log: ReadLog,
): { def: AxisDefinition; homing: AxisHomingDefinition; travel: number } | null {
  const name = axisSection(axis)
  const s = sections.get(name.toLowerCase())
  if (!s) return null

  const def = createDefaultAxisDefinition(axis)
  def.enabled = readBool(s, name, 'Axisenabled', false, log)
  def.stepsPerUnit = readNum(s, name, 'Stepsperunit', def.stepsPerUnit, log)
  // units/MIN in the profile AND in AxisDefinition. The bridge divides by 60,
  // src/ does not - doing it here would halve every feed twice over.
  def.maxVelocity = readNum(s, name, 'Velocity', def.maxVelocity, log)
  def.acceleration = readNum(s, name, 'Acceleration', def.acceleration, log)
  def.softLimitMax = readNum(s, name, 'Softlimitpositive', 0, log)
  def.softLimitMin = readNum(s, name, 'Softlimitnegative', 0, log)

  // `None` IS an answer this profile gave - "no slave on this axis" - so it is
  // recorded as stated. Only an omitted key, or a name that is not an axis,
  // leaves `slaveAxis: null` as this software's own default rather than his
  // machine's.
  const slaveWritten = rawOf(s, 'Slaveaxis')
  const slaveRaw = (slaveWritten ?? 'None').trim()
  if (slaveWritten !== undefined && slaveRaw === '') {
    // A BLANK IS NOT `None`, for the same reason a blank is not zero. The
    // field falls to null either way, but the definition gives `None` back,
    // and this key did not say `None` - it said nothing. Reported, unstated.
    def.slaveAxis = null
    log.issues.push({
      key: `${name}.Slaveaxis`,
      message: 'expected an axis name or None, found nothing',
    })
  } else if (slaveRaw.toLowerCase() === 'none') {
    def.slaveAxis = null
    if (slaveWritten !== undefined) state(log, name, 'Slaveaxis')
  } else {
    const match = SLAVE_NAMES.find((a) => a.toLowerCase() === slaveRaw.toLowerCase())
    def.slaveAxis = match ?? null
    if (match) state(log, name, 'Slaveaxis')
    if (!match) {
      log.issues.push({
        key: `${name}.Slaveaxis`,
        message: `"${slaveRaw}" is not an axis name - imported as NO slave rather than a guess, `
          + `because an invented pairing racks a gantry`,
      })
    }
  }

  def.stepPin = readPin(s, name, 'Stepportnumber', 'Steppinnumber', 'Steppinnegate', log)
  def.dirPin = readPin(s, name, 'Dirportnumber', 'Dirpinnumber', 'Dirpinnegate', log)
  def.homePin = readPin(s, name, 'Homeportnumber', 'Homepinnumber', 'Homepinnegate', log)
  def.limitMinusPin = readPin(s, name, 'Limitminusportnumber', 'Limitminuspinnumber', 'Limitminuspinnegate', log)
  def.limitPlusPin = readPin(s, name, 'Limitplusportnumber', 'Limitpluspinnumber', 'Limitpluspinnegate', log)
  def.enablePin = readPin(s, name, 'Enaportnumber', 'Enapinnumber', 'Enapinnegate', log)

  // *** THE 10x TRAP. See this file's header. Profile units are 10 ms steps. ***
  def.enableDelayMs = readNum(s, name, 'Enabledelay', 0, log) * 10

  def.backlash = {
    enabled: readBool(s, name, 'Backlashenable', false, log),
    // `Backlashdistance` - the full word. Verified against Operator's profile.
    distance: readNum(s, name, 'Backlashdistance', 0, log),
  }

  const homing: AxisHomingDefinition = {
    direction: readBool(s, name, 'Homedirectionpositive', true, log) ? 'positive' : 'negative',
    fastSpeed: readNum(s, name, 'Homingspeedup', 0, log),
    slowSpeed: readNum(s, name, 'Homingspeeddown', 0, log),
    // IMPORTED FAITHFULLY, INCLUDING 0. An earlier version of this file
    // raised a 0 to DEFAULT_HOME_BACK_OFF "so a finished cycle is
    // observable". That was wrong three times over and it was caught before
    // it reached Operator's machine:
    //
    //   1. It INVENTS A MACHINE FACT, which is the whole thing WO-924 exists
    //      to kill - and worse here than in the bridge, because the
    //      definition is what we are telling him to trust.
    //   2. THE DECISION WAS ALREADY MADE AND WENT THE OTHER WAY. The same 2mm
    //      was tried, measured at the machine on 2026-08-21 with him
    //      watching, and REMOVED - `Machine.cs:364-381` records it: "It was
    //      2 mm, and that was our invention: every axis in LienCNCV2.pro says
    //      Homebackoff=0, so UCCNC runs ONE fast approach and stops at the
    //      trip point, while we inserted a back-off and a slow re-approach
    //      UCCNC never runs here."
    //   3. THE STATED BENEFIT IS KNOWN FALSE. The board's HomeBackOff is the
    //      retreat BETWEEN the two approach stages, not a final one, so it
    //      does NOT leave the axis off its switch. It never bought what it
    //      was added for.
    //
    // Operator DID ask for a final back-off on 2026-08-21 ("back it off in our
    // settings so you can tell it was done"). That is the BRIDGE running one
    // after StampAxis, and it is a separate order. It is not the importer
    // quietly changing his number.
    backOff: readNum(s, name, 'Homebackoff', 0, log),
    homingValue: readNum(s, name, 'Homingvalue', 0, log),
    autoZero: readBool(s, name, 'Homeautozero', true, log),
  }
  // Travel is the span the soft limits describe, which is what the machine
  // actually permits - not a separate number somebody typed.
  const travel = Math.max(0, def.softLimitMax - def.softLimitMin)
  return { def, homing, travel }
}

const UCCNC_FAULT_SIGNAL_ROWS = 15

const importedNumber = (definition: ControllerDefinition, key: string): number | null => {
  const value = controllerSettingValue(definition.settings, 'uccnc', key)
  return value?.kind === 'number' && Number.isFinite(value.value) ? value.value : null
}

const importedBoolean = (definition: ControllerDefinition, key: string): boolean | null => {
  const value = controllerSettingValue(definition.settings, 'uccnc', key)
  return value?.kind === 'boolean' ? value.value : null
}

/**
 * Decode UCCNC's numbered FaultSignals table into the controller-neutral list.
 * Disabled rows are retained in the archived typed settings but do not become
 * live inputs. An enabled, incomplete row stays visible as one unassigned
 * input plus a named import issue; dropping it would silently turn "enabled
 * but broken" into "this machine has no fault input".
 */
function driveFaultInputsFromUccnc(
  definition: ControllerDefinition,
  issues: ProfileImportIssue[],
): PinRef[] | undefined {
  const inputs: PinRef[] = []
  for (let row = 1; row <= UCCNC_FAULT_SIGNAL_ROWS; row++) {
    const stem = 'FaultSignals'
    if (importedBoolean(definition, `${stem}.Enable${row}`) !== true) continue
    const port = importedNumber(definition, `${stem}.Port${row}`)
    const pin = importedNumber(definition, `${stem}.Pin${row}`)
    if (port !== null && pin !== null && port > 0 && pin > 0) {
      inputs.push({
        port,
        pin,
        negate: importedBoolean(definition, `${stem}.ActiveLow${row}`),
      })
      continue
    }
    inputs.push({ ...UNASSIGNED_PIN })
    issues.push({
      key: `${stem}.Port${row}/Pin${row}`,
      message: `fault signal ${row} is enabled but has no complete assigned pin; `
        + 'the definition keeps the input unassigned rather than inventing wiring',
    })
  }
  return inputs.length > 0 ? inputs : undefined
}

/**
 * UCCNC has no separate primary-charge-pump enable or frequency key. Its
 * stated 0/0 port/pin pair is explicit off; a complete positive pair is on.
 * Anything else is incomplete and remains only in the archived raw settings
 * with an issue. The fixed waveform documented by UCCNC is not copied into
 * `frequencyHz`: the profile did not state it and this importer never guesses.
 */
function chargePumpFromUccnc(
  definition: ControllerDefinition,
  io: Section | undefined,
  issues: ProfileImportIssue[],
): ControllerDefinition['chargePump'] {
  const portKey = 'Chargepumpportnumber'
  const pinKey = 'Chargepumppinnumber'
  const hasPort = io?.values.has(portKey.toLowerCase()) === true
  const hasPin = io?.values.has(pinKey.toLowerCase()) === true
  if (!hasPort && !hasPin) return undefined

  const port = importedNumber(definition, `IOsetupsettings.${portKey}`)
  const pin = importedNumber(definition, `IOsetupsettings.${pinKey}`)
  if (port === 0 && pin === 0) return { enabled: false }
  if (port !== null && pin !== null && port > 0 && pin > 0) {
    return {
      enabled: true,
      pin: {
        port,
        pin,
        negate: importedBoolean(definition, 'IOsetupsettings.Chargepumppinnegate'),
      },
    }
  }

  issues.push({
    key: `IOsetupsettings.${portKey}/${pinKey}`,
    message: 'the charge pump has an incomplete pin pair; the definition leaves its state '
      + 'unstated rather than guessing on or off',
  })
  return undefined
}

/**
 * Read a UCCNC `.pro` into a `ControllerDefinition`.
 *
 * Never throws on bad input: a machine definition is a safety surface and a
 * half-read profile must be VISIBLY half-read, not an exception someone
 * catches and replaces with defaults.
 */
export function importUccncProfile(text: string): ProfileImportResult {
  const log: ReadLog = { issues: [], stated: [] }
  const issues = log.issues
  const empty: ProfileImportResult = {
    definition: null, travel: null, toolSetter: null, controllerBoard: null,
    profileName: null, issues, unsent: [], unmodelled: [],
  }

  if (typeof text !== 'string' || text.trim() === '') {
    issues.push({ key: '(file)', message: 'the file is empty' })
    return empty
  }

  const sections = parseIni(text)
  if (sections.size === 0) {
    issues.push({ key: '(file)', message: 'no [Section] headers - this is not a UCCNC profile' })
    return empty
  }

  const definition = createDefaultControllerDefinition()
  const controllerBoard = readUccncBoardDeviceType(sections, log)
  const perAxis: Partial<Record<AxisName, AxisHomingDefinition>> = {}
  const axes: AxisDefinition[] = []
  const travel = { x: 0, y: 0, z: 0 }
  let sawAnyAxis = false

  for (const axis of PROFILE_AXES) {
    const read = readAxis(sections, axis, log)
    if (!read) {
      // X, Y and Z absent is a real problem; A/B/C absent is an ordinary
      // 3-axis machine and must not be reported as a fault.
      if (axis === 'X' || axis === 'Y' || axis === 'Z') {
        issues.push({ key: `[${axisSection(axis)}]`, message: 'section missing from the profile' })
      }
      continue
    }
    sawAnyAxis = true
    axes.push(read.def)
    perAxis[axis] = read.homing
    if (axis === 'X') travel.x = read.travel
    if (axis === 'Y') travel.y = read.travel
    if (axis === 'Z') travel.z = read.travel
  }

  if (!sawAnyAxis) {
    issues.push({ key: '(file)', message: 'no axis sections found - this is not a UCCNC profile' })
    return empty
  }

  definition.axes = axes
  definition.homing.perAxis = perAxis

  // THE ORDER **IS** IN THE PROFILE, and an earlier draft of this file said it
  // was not. `[Generalsettings] Homesequence1..6`, each an axis name or the
  // literal `None`. Operator's reads Z, X, Y.
  //
  // We READ it rather than imposing our default, because "the machine
  // definition needs to be obeyed" is the entire mandate this importer exists
  // to satisfy - substituting our own order would be the same disobedience in
  // a nicer hat. But Z-first is a SAFETY property, not a preference
  // (types/index.ts:275-284: homing Z last drives a tool through the work on
  // its way to an X or Y switch), so an order that does not lead with Z is
  // REPORTED loudly and still obeyed. Silently reordering would hide it; the
  // operator decides.
  const general = sections.get('generalsettings')
  const slots: (string | undefined)[] = []
  for (let i = 1; i <= 6; i++) slots.push(rawOf(general, `Homesequence${i}`))
  const sequence: AxisName[] = []
  slots.forEach((written, index) => {
    const raw = (written ?? '').trim()
    if (raw === '' || raw.toLowerCase() === 'none') return
    const match = SLAVE_NAMES.find((a) => a.toLowerCase() === raw.toLowerCase())
    if (!match) {
      issues.push({
        key: `Generalsettings.Homesequence${index + 1}`,
        message: `"${raw}" is not an axis name - dropped from the homing order`,
      })
      return
    }
    if (!sequence.includes(match)) sequence.push(match)
  })
  if (sequence.length === 0) {
    definition.homing.order = [...DEFAULT_HOMING_ORDER]
    issues.push({
      key: 'Generalsettings.Homesequence1',
      message: `no homing sequence in the profile - imported the safe default `
        + `(${DEFAULT_HOMING_ORDER.join(', ')}), which retracts Z before anything moves in plane`,
    })
  } else {
    definition.homing.order = sequence
    if (sequence.includes('Z') && sequence[0] !== 'Z') {
      issues.push({
        key: 'Generalsettings.Homesequence1',
        message: homingZNotFirstMessage(sequence.join(', ')),
      })
    }
  }

  // AND THEIR PROVENANCE, DECIDED BY READING THE DEFINITION BACK.
  //
  // Six keys collapse into ONE ordered list, and a list is a lossy home for
  // six slots: a duplicate name is dropped, a gap closes up, and where no slot
  // named an axis at all the list is OUR safe default rather than his machine.
  // A slot marked stated in any of those cases claims the definition can give
  // it back when it cannot - the same defect as a half-assigned pin, one
  // container to the left.
  //
  // So each slot is stated only if reading `homing.order` at that position
  // reproduces what the file wrote there: the axis at that index, or `None`
  // past the end of the list. Anything else is reported by name and left
  // unstated, unless the slot already has an issue of its own.
  slots.forEach((written, index) => {
    if (written === undefined) return
    const key = `Homesequence${index + 1}`
    const order = definition.homing.order
    const back: string = index < order.length ? order[index] : 'None'
    if (written.trim().toLowerCase() === back.toLowerCase()) {
      state(log, 'Generalsettings', key)
      return
    }
    if (issues.some((issue) => issue.key === `Generalsettings.${key}`)) return
    issues.push({
      key: `Generalsettings.${key}`,
      message: `this profile's homing order reads back as ${order.join(', ')}, which does not `
        + `give slot ${index + 1} back as "${written.trim()}" - the slot is imported but not `
        + `recorded as something the profile stated`,
    })
  })

  const io = sections.get('iosetupsettings')
  definition.io = {
    estop: readPin(io, 'IOsetupsettings', 'Estopportnumber', 'Estoppinnumber', 'Estoppinnegate', log),
    probe: readPin(io, 'IOsetupsettings', 'Probeportnumber', 'Probepinnumber', 'Probepinnegate', log),
    probe2: readPin(io, 'IOsetupsettings', 'Probeport2number', 'Probepin2number', 'Probepin2negate', log),
  }

  // PROFILE IDENTITY, NOT A MACHINE SETTING, and deliberately not recorded in
  // `stated`. `Generalsettings.Profilename` is what UCCNC calls this profile;
  // it lands on `MachineConfig.name`, which is one level ABOVE the controller
  // definition, so a definition that "states" it would be claiming a field it
  // does not have. It is the catalogue's one identity key - and his own file
  // does not even carry it, which is why the suite counts 1680 machine keys
  // and a 1681st catalogue entry for the name.
  const profileName = rawOf(general, 'Profilename') ?? null

  // LAST, and that is load-bearing: this reads every key nobody asked for,
  // so it can only be right once every reader above has had its turn.
  const { settings, unsent, unmodelled } = collectSettings(sections, issues)
  const startupWorkOffsets = collectStartupWorkOffsets(sections, issues)

  // THE MODELLED SETTINGS GO ON THE DEFINITION, not beside it. This record is
  // the machine definition ADR-0044 requirement 5 measures, so a key that is
  // modelled but parked outside it is a key the definition still cannot
  // express. `ProfileImportResult` deliberately has no second `settings`
  // field: a machine fact lives in exactly one place, and one of two copies
  // is always the one that goes stale.
  definition.settings = [...settings, ...startupWorkOffsets]
  const toolSetter = toolSetterFromUccncDefinition(definition)

  // FaultSignals and the primary charge-pump keys are import aliases. Keep
  // their typed raw values as archived/exportable UCCNC data, but put the
  // runtime facts on the controller-neutral fields every controller consumes.
  // Machine.cs must never reread these aliases once its WO-1729 phase lands.
  const driveFaultInputs = driveFaultInputsFromUccnc(definition, issues)
  if (driveFaultInputs !== undefined) definition.driveFaultInputs = driveFaultInputs
  const chargePump = chargePumpFromUccnc(definition, io, issues)
  if (chargePump !== undefined) definition.chargePump = chargePump

  // AND THE OUTPUTS THE PROFILE STATES, AS LIST ENTRIES (WO-1649). This is the
  // one read of `Floodmistrelaysenabled`, the M7/M8/M3/M4 relay pins and the
  // on/off delays; from here on every route that switches a pin asks
  // `resolveMachineOutputWord`, which reads this list and knows no controller.
  // It runs AFTER `definition.settings` because that is where it reads from.
  definition.outputs = definitionOutputsFromSettings(definition)

  // UCCNC NAMES ARE IMPORT/EXPORT ALIASES, NOT THE QUESTIONS THE APP ASKS
  // (WO-1731). Preserve every raw key above exactly where the catalogue and
  // exporter already find it, then state the equivalent app-owned facts under
  // the machine's controller. Named fields keep their values; Safe Z keeps its
  // one numeric authority in Generalsettings.SafeZ. The app records only the
  // fact's provenance here, so an edit cannot leave two numeric copies to
  // disagree. A future controller importer can make the same statements
  // without teaching any reader that controller's vocabulary.
  const importedStates = (key: string): boolean => definitionStatesKey(
    { settings: definition.settings, stated: log.stated }, 'uccnc', key,
  )
  const stateAppFact = (rawKey: string, appKey: string): void => {
    let marked = false
    definition.settings = (definition.settings ?? []).map((entry) => {
      if (marked || entry.controller !== 'uccnc'
        || entry.key.toLowerCase() !== rawKey.toLowerCase()) return entry
      marked = true
      return { ...entry, appKey }
    })
    if (marked) return
    log.stated = log.stated.map((entry) => {
      if (marked || entry.controller !== 'uccnc'
        || entry.key.toLowerCase() !== rawKey.toLowerCase()) return entry
      marked = true
      return { ...entry, appKey }
    })
  }
  if (importedStates(UCCNC_SAFE_Z_KEY)) stateAppFact(UCCNC_SAFE_Z_KEY, LIENCAM_SAFE_Z_KEY)
  for (const axis of axes) {
    if (importedStates(uccncAxisHomeBackOffKey(axis.axis))) {
      stateAppFact(uccncAxisHomeBackOffKey(axis.axis), axisHomeBackOffStatementKey(axis.axis))
    }
    if (importedStates(uccncAxisHomingKey(axis.axis, 'direction'))) {
      stateAppFact(
        uccncAxisHomingKey(axis.axis, 'direction'),
        axisHomingStatementKey(axis.axis, 'direction'),
      )
    }
    if (importedStates(uccncAxisHomingKey(axis.axis, 'homingValue'))) {
      stateAppFact(
        uccncAxisHomingKey(axis.axis, 'homingValue'),
        axisHomingStatementKey(axis.axis, 'homingValue'),
      )
    }
    const root = `axessettingscontrol${axis.axis}`
    for (const rawName of [
      'Currhilowportnumber', 'Currhilowpinnumber', 'Currhilowpinnegate',
      'Rotaryaxis', 'Rotaryrollover',
    ]) {
      const rawKey = `${root}.${rawName}`
      const appKey = axisDriveAppKey(rawKey)
      if (appKey !== undefined && importedStates(rawKey)) stateAppFact(rawKey, appKey)
    }
    if (importedStates(`${root}.Homeportnumber`)
      && importedStates(`${root}.Homepinnumber`)) {
      stateAppFact(`${root}.Homeportnumber`, axisHomeInputStatementKey(axis.axis))
    }
  }

  // AND THE PROVENANCE OF THE NAMED FIELDS, on the definition for the same
  // reason. Which keys this profile actually stated is a fact ABOUT THIS
  // MACHINE DEFINITION: without it, `axes[X].softLimitMax === 0` cannot be
  // told apart from a profile that omitted `Softlimitpositive` entirely, and
  // the definition asserts a soft limit nobody wrote. Only the keys a named
  // field consumed are listed - `settings` states its own 1489 by holding
  // them, and `definitionStatesKey` reads both so no caller has to know.
  definition.stated = log.stated

  // All settings also shows the parts of the file that describe UCCNC
  // itself rather than this machine. Keep their exact file text in the typed,
  // persisted display-only collection; the catalogue comparison above is the
  // sole answer to whether LienCAM uses a key.
  definition.profileOnlySettings = collectProfileOnlySettings(sections)

  // Import diagnostics are facts about THIS definition, not about a fixture
  // id and not about `unsent`: malformed purpose-built values never reach the
  // latter. Carry the exact records on the persisted definition so every
  // imported machine can name them after save/reload and while switching.
  if (issues.length > 0) definition.importIssues = issues.map((issue) => ({ ...issue }))

  importedUccncControllerBoards.set(definition, controllerBoard)
  return {
    definition, travel, toolSetter, controllerBoard, profileName, issues, unsent, unmodelled,
  }
}

/**
 * Decode UCCNC's import alias once, at the profile boundary. Machine readers
 * never know this controller key. Observed machine behaviour establishes
 * X/Y/Z at pairs 2-3, 4-5, and 6-7 after the tuple's first saved pair.
 * Disabled axes remain absent, while zero and negatives are facts.
 */
export function toolSetterFromUccncDefinition(
  definition: ControllerDefinition | null | undefined,
): Partial<Vec3> | null {
  const setting = definition?.settings?.find(
    (entry) => entry.controller === 'uccnc'
      && entry.key.toLowerCase() === 'probing.fixedprobepos',
  )
  if (!setting || setting.value.kind !== 'tuple') return null
  const slots = setting.value.value
  const coordinate = (flagSlot: number): number | undefined => {
    const flag = slots[flagSlot]
    const value = slots[flagSlot + 1]
    return flag?.kind === 'boolean' && flag.value
      && value?.kind === 'number' && Number.isFinite(value.value)
      ? value.value
      : undefined
  }
  const result: Partial<Vec3> = {}
  const x = coordinate(2)
  const y = coordinate(4)
  const z = coordinate(6)
  if (x !== undefined) result.x = x
  if (y !== undefined) result.y = y
  if (z !== undefined) result.z = z
  return Object.keys(result).length > 0 ? result : null
}

/** Apply the imported app-owned facts with replace semantics. Probe defaults
 * stay intact, while board identity goes through the one shared board writer.
 * Missing profile facts clear prior imported/app facts rather than inventing
 * values during hydration. Every current import/confirm/seed route uses this
 * boundary, so none can persist a different result from the preview. */
const importedUccncControllerBoards = new WeakMap<
  ControllerDefinition,
  MachineControllerBoard | null
>()

export function withImportedUccncToolSetter<T extends MachineConfig>(
  machine: T,
  toolSetter: Partial<Vec3> | null,
): T {
  let next: T
  if (toolSetter !== null) {
    next = {
      ...machine,
      probing: {
        ...DEFAULT_MACHINE_PROBE_DEFAULTS,
        ...machine.probing,
        toolSetter: { ...toolSetter },
      },
    }
  } else if (!machine.probing || machine.probing.toolSetter === undefined) {
    next = machine
  } else {
    const { toolSetter: _removed, ...probing } = machine.probing
    next = { ...machine, probing: probing as MachineProbeDefaults }
  }

  const definition = machine.controllerDefinition
  if (!definition || !importedUccncControllerBoards.has(definition)) return next
  const imported = importedUccncControllerBoards.get(definition) ?? null
  return withUccncBoardDeviceType(next, imported?.deviceType ?? null) as T
}

const IMPORTED_AXIS_KEYS = [
  'Axisenabled', 'Stepsperunit', 'Velocity', 'Acceleration',
  'Softlimitpositive', 'Softlimitnegative', 'Slaveaxis',
  'Stepportnumber', 'Steppinnumber', 'Steppinnegate',
  'Dirportnumber', 'Dirpinnumber', 'Dirpinnegate',
  'Homeportnumber', 'Homepinnumber', 'Homepinnegate',
  'Limitminusportnumber', 'Limitminuspinnumber', 'Limitminuspinnegate',
  'Limitplusportnumber', 'Limitpluspinnumber', 'Limitpluspinnegate',
  'Enaportnumber', 'Enapinnumber', 'Enapinnegate',
  'Enabledelay', 'Backlashenable', 'Backlashdistance',
  'Homedirectionpositive', 'Homingspeedup', 'Homingspeeddown',
  'Homebackoff', 'Homingvalue', 'Homeautozero',
] as const

const IMPORTED_IO_KEYS = [
  'Estopportnumber', 'Estoppinnumber', 'Estoppinnegate',
  'Probeportnumber', 'Probepinnumber', 'Probepinnegate',
  'Probeport2number', 'Probepin2number', 'Probepin2negate',
] as const

/**
 * Name every field a readable profile did not fill in the purpose-built
 * definition. Defaults remain useful for editing, but they are not evidence
 * that the file stated a value. The preview prints this list before Confirm.
 */
export function unimportedUccncProfileFields(result: ProfileImportResult): string[] {
  const definition = result.definition
  if (!definition) return []

  const gaps = new Set<string>(result.unmodelled)
  for (const axis of definition.axes) {
    const section = axisSection(axis.axis)
    for (const key of IMPORTED_AXIS_KEYS) {
      const full = `${section}.${key}`
      if (!definitionStatesKey(definition, 'uccnc', full)) gaps.add(full)
    }
  }
  for (const key of IMPORTED_IO_KEYS) {
    const full = `IOsetupsettings.${key}`
    if (!definitionStatesKey(definition, 'uccnc', full)) gaps.add(full)
  }

  return [...gaps]
}

/**
 * One board translation result. The bridge owns the board-specific pin table;
 * this module only compares the results it is handed. A refusal is a result,
 * not a missing value, so two refusals compare equal and a refusal differs
 * from every translated board pin.
 */
export type ProfilePinTranslation =
  | { kind: 'translated'; boardPin: number }
  | { kind: 'refused'; reason: string }

/**
 * Profile absence is a comparison state and an apply action. UCCNC import
 * resolves a missing pin to UNASSIGNED_PIN, so applying it clears the current
 * assignment rather than preserving it.
 */
export type ProfilePinNotInProfile = {
  kind: 'not-in-profile'
  applyEffect: 'clear'
}

export type ProfilePinComparisonInput =
  | {
      key: string
      rawAfter: PinRef
      oldResult: ProfilePinTranslation
      newResult: ProfilePinTranslation
    }
  | {
      key: string
      rawAfter: null
      oldResult: ProfilePinTranslation
      newResult: ProfilePinNotInProfile
    }

export type ProfilePinComparisonState = 'unchanged' | 'changed' | 'not-in-profile'

export interface ProfilePinComparisonRow {
  /** Stable field identity, for example `axis.X.stepPin` or `io.estop`. */
  key: string
  group: string
  label: string
  /** Physical connector values are context. They never decide the verdict. */
  rawBefore: PinRef
  rawAfter: PinRef | null
  /** Structured results let a caller render without parsing the text. */
  oldResult: ProfilePinTranslation
  newResult: ProfilePinTranslation | ProfilePinNotInProfile
  /** Printable result columns. Refusals and absence are always said in words. */
  boardBefore: string
  boardAfter: string
  /** Profile absence is its own state, never disguised as `unchanged`. */
  state: ProfilePinComparisonState
  /** Whether the result values differ, independent of the display state. */
  changed: boolean
  /** Same physical pin, different result: the real-machine failure case. */
  translationOnly: boolean
  /** Plain-language consequence. Never empty. */
  outcome: string
}

interface MachinePinField {
  key: string
  group: string
  label: string
  raw: PinRef
}

const AXIS_COMPARISON_PIN_FIELDS: readonly {
  key: string
  label: string
  read: (axis: AxisDefinition) => PinRef
}[] = [
  { key: 'stepPin', label: 'step pin', read: (axis) => axis.stepPin },
  { key: 'dirPin', label: 'direction pin', read: (axis) => axis.dirPin },
  { key: 'homePin', label: 'home pin', read: (axis) => axis.homePin },
  { key: 'limitMinusPin', label: 'limit minus pin', read: (axis) => axis.limitMinusPin },
  { key: 'limitPlusPin', label: 'limit plus pin', read: (axis) => axis.limitPlusPin },
  { key: 'enablePin', label: 'enable pin', read: (axis) => axis.enablePin },
]

const formatProfilePinResult = (
  result: ProfilePinTranslation | ProfilePinNotInProfile,
): string => {
  if (result.kind === 'translated') return `UCpin ${result.boardPin}`
  if (result.kind === 'not-in-profile') return 'NOT IN PROFILE'
  const reason = result.reason.trim() || 'this pin cannot be translated'
  return `REFUSED: ${reason}`
}

const sameProfilePinResult = (
  left: ProfilePinTranslation | ProfilePinNotInProfile,
  right: ProfilePinTranslation | ProfilePinNotInProfile,
): boolean => {
  if (left.kind !== right.kind) return false
  if (left.kind !== 'translated' || right.kind !== 'translated') return true
  return Object.is(left.boardPin, right.boardPin)
}

const sameRawPin = (left: PinRef, right: PinRef | null): boolean =>
  right !== null
  && left.port === right.port
  && left.pin === right.pin
  && left.negate === right.negate

function machinePinFields(machine: ControllerDefinition): MachinePinField[] {
  const fields: MachinePinField[] = []
  for (const axis of machine.axes) {
    for (const field of AXIS_COMPARISON_PIN_FIELDS) {
      fields.push({
        key: `axis.${axis.axis}.${field.key}`,
        group: `${axis.axis} axis`,
        label: field.label,
        raw: field.read(axis),
      })
    }
  }
  fields.push(
    { key: 'io.estop', group: 'Inputs', label: 'e-stop input', raw: machine.io.estop },
    { key: 'io.probe', group: 'Inputs', label: 'probe input', raw: machine.io.probe },
    { key: 'io.probe2', group: 'Inputs', label: 'probe 2 input', raw: machine.io.probe2 },
  )
  const driveFaultInputs = machine.driveFaultInputs ?? []
  for (let index = 0; index < driveFaultInputs.length; index++) {
    fields.push({
      key: `driveFaultInputs.${index}`,
      group: 'Drive safety',
      label: `drive-fault input ${index + 1}`,
      raw: driveFaultInputs[index],
    })
  }
  if (machine.chargePump?.pin) {
    fields.push({
      key: 'chargePump.pin',
      group: 'Drive safety',
      label: 'charge-pump output',
      raw: machine.chargePump.pin,
    })
  }
  return fields
}

/**
 * Compare every pin the machine has against a profile preview.
 *
 * This is deliberately total, not a diff: every machine pin returns one row.
 * Board translation is injected as data, so the function has no bridge, store
 * or rendering dependency and cannot grow a second copy of the UCpin table.
 */
export function compareUccncProfilePins(
  machine: ControllerDefinition,
  profile: readonly ProfilePinComparisonInput[],
): ProfilePinComparisonRow[] {
  const byKey = new Map(profile.map((pin) => [pin.key, pin] as const))

  return machinePinFields(machine).map((field) => {
    const supplied = byKey.get(field.key)
    const oldResult: ProfilePinTranslation = supplied?.oldResult ?? {
      kind: 'refused',
      reason: 'the current board translation was not reported',
    }
    const newResult: ProfilePinTranslation | ProfilePinNotInProfile =
      supplied?.newResult ?? { kind: 'not-in-profile', applyEffect: 'clear' }
    const rawAfter = supplied?.rawAfter ?? null
    const boardBefore = formatProfilePinResult(oldResult)
    const boardAfter = formatProfilePinResult(newResult)

    // THE WHOLE VERDICT: compare the results. There is no exception for a
    // refusal; REFUSED is a value and differs from translation and absence.
    const changed = !sameProfilePinResult(oldResult, newResult)
    const state: ProfilePinComparisonState = newResult.kind === 'not-in-profile'
      ? 'not-in-profile'
      : changed ? 'changed' : 'unchanged'
    const translationOnly = changed && sameRawPin(field.raw, rawAfter)

    const outcome = state === 'not-in-profile'
      ? `NOT IN PROFILE: ${field.label} has no profile value. Applying this profile will clear `
        + `the ${field.label} assignment and leave it unassigned (currently ${boardBefore}).`
      : state === 'unchanged'
        ? `UNCHANGED: ${field.label} remains ${boardAfter}.`
        : translationOnly
          ? `CHANGED: the raw pin is identical, but ${boardBefore} becomes ${boardAfter}.`
          : `CHANGED: ${boardBefore} becomes ${boardAfter}.`

    return {
      key: field.key,
      group: field.group,
      label: field.label,
      rawBefore: field.raw,
      rawAfter,
      oldResult,
      newResult,
      boardBefore,
      boardAfter,
      state,
      changed,
      translationOnly,
      outcome,
    }
  })
}

// ============================================================================
// WO-1002 - THE DRY RUN. What a profile WOULD change, before anything changes.
// ============================================================================
//
// A profile import that applies first and reports second is how the
// pin-translation hazard reached a real machine (MACHINE-SETTINGS-DESIGN 4.2).
// So reading and writing are two acts with a person in between: everything in
// this block READS and DESCRIBES. Nothing here writes anything, anywhere.
//
// The bridge's landed `previewProfile` reply is a raw ordered tuple list. This
// module adapts it through the established importer and diff tables; it does
// not invent a second translation or write through a separate profile verb.
// Older bridges answer with the protocol's unknown-method refusal and the
// surface says so in plain words rather than pretending.
//
// WHY THE BRIDGE AND NOT `importUccncProfile` ABOVE. Design rule 2: the `.pro`
// already lives on the machine PC and the bridge already enumerates every one
// of them into `hello.uccnc.profiles`. Import is PICK, not UPLOAD. And design
// rule 4: the preview must run THE REAL TRANSLATION - the same `UCPin`
// function the real import uses - so a preview that reads correctly and an
// import that goes wrong cannot diverge. A second translator in TypeScript is
// the one thing design rule 1 forbids: nothing in this file computes a UCpin,
// it only prints the one the bridge reported.

// ---------------------------------------------------------------------------
// THE WIRE SHAPES - the historical rich test seam and the landed raw reply
// ---------------------------------------------------------------------------

/**
 * WHAT ONE RAW PIN BECOMES ON THIS BOARD - one side of one comparison.
 *
 * `ucPin` IS REPORTED, NEVER COMPUTED. `(port, pin)` is the physical location
 * a person reads off a wiring diagram; the UCpin is the board's own numbering,
 * and there is exactly one copy of that arithmetic and it is in the bridge
 * (design rule 1, and `controller.ts`'s `applyMachineDefinition` says the same
 * thing for the apply path).
 *
 * `status` is the explicit flag design rule 4 asks for, because "we did not
 * assign it", "that is not an output on this board" and "I cannot translate
 * this at all" are three different facts and a report that renders all three
 * as a blank is the silence this order exists to remove.
 *
 *   ok              translated; `ucPin` is a number and may be printed.
 *   unassigned      the raw pin is 0/0. Nobody assigned it - that is an
 *                   answer, not a failure, and not a board pin.
 *   not-an-output   the board REFUSES it. A fact about the board that an
 *                   otherwise-identical import leaves in place, still broken.
 *   untranslatable  the bridge tried and cannot say - an untranscribed pin
 *                   table, a port this board does not have. IT NEVER CARRIES
 *                   A NUMBER (completeness contract 5).
 *   absent          there is no pin on this side to translate at all.
 *   unreported      THE BRIDGE SAID NOTHING about this side. Only this file
 *                   produces it, never a bridge: it is what a missing entry
 *                   is called, so a pin can be listed as unknown instead of
 *                   being dropped or given a number nobody sent.
 */
export type PinTranslationStatus =
  | 'ok'
  | 'unassigned'
  | 'not-an-output'
  | 'untranslatable'
  | 'absent'
  | 'unreported'

export interface BridgeProfilePinTranslation {
  /** The board numbering the bridge WOULD write. NULL for every status but
   *  `ok` - and a null here is never printed as anything but words. */
  ucPin: number | null
  status: PinTranslationStatus
  /** The bridge's own words for why, when it has any. Null otherwise. */
  detail: string | null
}

/**
 * One pin as the bridge sees it: what the machine holds NOW, what the profile
 * says, and WHAT EACH OF THOSE BECOMES ON THE BOARD.
 *
 * BOTH SIDES ARE TRANSLATED BY THE BRIDGE, and that is the whole reason this
 * carries two translations rather than one (completeness contract 2-3). The
 * translation is the half that reached a real machine: a pin whose raw value
 * does not move can still translate differently - a re-transcribed pin table,
 * a different board - and the operator would see `port 2 pin 3` on both sides
 * and read a no-op. Comparing raw values hides exactly the hazard the dry run
 * exists to show, so the comparison this file makes is translated against
 * translated and the raw pair is shown beside it as context.
 *
 * `inProfile` is the third state (completeness contract 4). A profile that is
 * SILENT about a pin has not confirmed it, so it may not be called
 * "unchanged", and it has no value, so it may not be rendered blank.
 */
export interface BridgeProfilePinPreview {
  /** Matches the report row it annotates - `axis.X.stepPin`, `io.estop`. */
  key: string
  label: string
  /** False when the profile does not mention this pin AT ALL. */
  inProfile: boolean
  /** The raw pair THE PROFILE carries. Null throughout when `!inProfile` -
   *  never 0/0, which would be the profile claiming "unassigned". */
  port: number | null
  pin: number | null
  /** Three values, not two: `null` is "the profile did not say". */
  negate: boolean | null
  /** What the machine's CURRENT raw pin becomes on this board. */
  current: BridgeProfilePinTranslation
  /** What the profile's pin WOULD become on this board. */
  proposed: BridgeProfilePinTranslation
}

/** One value the bridge says a re-import will replace. WO-1040 phase B owns
 * the producer; keeping this optional lets an older bridge continue to use the
 * app's own provenance without pretending it reported a list. */
export interface BridgeProfileReplacement {
  /** The bridge drift key, for example `axes.X.acceleration`. */
  key: string
  /** The cached value the profile will replace. */
  ours: string
  /** The value read from the selected profile. */
  profile: string
  provenance: MachineDefinitionProvenanceEntry
}

/**
 * The reply to `previewProfile { path }` - design rule 4's read-only call.
 *
 * READ-ONLY IS THE WHOLE POINT: it parses the INI and runs `ProfilePin`, and
 * calls no `Set*` on the board. Nothing about the machine changes because
 * somebody looked at a profile.
 *
 * `definition` is the profile mapped into LienCAM's OWN shape, by the bridge,
 * because Operator ruled on 2026-08-23 that we own the profile and the `.pro` is
 * an import source (design 4.7). It carries pins as `(port, pin)` exactly as
 * `ControllerDefinition` always has - our JSON stores the raw values and lets
 * the bridge translate, so rule 1 stands untouched.
 */
export interface BridgeProfilePreviewReply {
  /** The bridge could read this path as a profile at all. */
  ok: boolean
  /** Why not, in the bridge's own words. Null when `ok`. */
  error: string | null
  /** Echoed back, so a late reply can be matched to the row it was asked for. */
  path: string
  profileName: string | null
  /**
   * The board this bridge is talking to, and whether its pin table has been
   * transcribed. Design rule 3 gates the pin import on this - THAT GATE IS
   * WO-1001's, not this order's. Carried here so the contract has one shape
   * and the surface can state the board rather than leave it unsaid.
   */
  board: { type: string | null; pinTranslation: boolean }
  /** Null whenever `ok` is false. */
  definition: ControllerDefinition | null
  travel: { x: number; y: number; z: number } | null
  /** App-owned import alias. Absent on older bridge replies means unchanged. */
  controllerBoard?: MachineControllerBoard | null
  /** Optional during bridge rollout; absent replies decode their definition. */
  toolSetter?: Partial<Vec3> | null
  /**
   * ONE ENTRY PER PIN THE MACHINE HAS, NEVER A SUBSET AND NEVER A DIFF.
   *
   * The bridge is handed the machine's current definition with the request
   * precisely so it can answer for every pin on it - including the ones this
   * profile never mentions, which get `inProfile: false` rather than being
   * left out. A pin missing from a preview is a pin nobody reviewed
   * (completeness contract 5), so this file treats an absent entry as
   * `unreported` and prints it as unknown rather than trusting the omission.
   */
  pins: BridgeProfilePinPreview[]
  /** Machine-describing keys this software cannot send yet (WO-947). */
  unsent: UnsentSetting[]
  /** Anything the bridge wants a person to read before agreeing. */
  warnings: string[]
  /** WO-1082 / WO-1040 phase B. Absent means this bridge has not implemented
   * the replaced-value report yet; an empty array is a stated empty report. */
  replaced?: BridgeProfileReplacement[]
}

/** During rollout the preview surface can receive either the historical fake
 * used by WO-1002's translation tests or the landed raw tuple reply. Real
 * UccncController instances return the latter. */
export type ProfilePreviewReply = BridgeProfilePreviewReply | BridgePreviewProfileReply

/**
 * The reply to `setBridgeProfile { path }`.
 *
 * IT WRITES A CONFIG FILE, IT DOES NOT SET A PROFILE. The bridge reads
 * `--profile` ONCE, at `Open`, and deliberately accepts no wire setter for it
 * (`Bridge.cs:312-319`; design 3.2 names `--profile` as one of the three flags
 * that genuinely require a restart). So this call writes the choice into
 * `liencam-bridge.config.json`, which the bridge re-reads on its NEXT start,
 * and that is the entirety of what it does.
 *
 * `runningProfile` is what the bridge is STILL running, unchanged by this
 * call, and it is here so the browser can never be tempted to infer otherwise
 * from `ok: true`.
 *
 * WO-1002 attempt 4 - `requestedProfile` IS PART OF THE CONTRACT, for the same
 * reason `BridgeProfilePreviewReply.path` already is: this is an async call, so
 * a reply can land after the person has moved on, and a reply that does not
 * carry the identity of what it answers can only be attributed by guessing at
 * what is on screen when it arrives. That guess is the audited defect - a
 * write requested for profile A reported as A's result against profile B, so
 * the operator is told B is pending when nothing about B was ever sent.
 */
export interface BridgeSetProfileReply {
  ok: boolean
  error: string | null
  /** Echoed back, so a reply can be matched to the request it answers rather
   *  than to whatever the person happens to have selected when it lands. */
  requestedProfile: string
  /** The file the bridge wrote, named so a person can go and look at it. */
  configPath: string | null
  written: boolean
  /** Always true. A config write is not a restart and never becomes one. */
  restartRequired: boolean
  /** What the live process opened at startup. NOT the path just written. */
  runningProfile: string | null
}

/**
 * What a backend must implement for this surface to work at all.
 *
 * Optional on purpose, and asked for with `typeof` rather than assumed - the
 * same shape `controller.ts` documents for `applyMachineDefinition`. A bridge
 * build that predates the machine half answers the protocol's unknown-method
 * refusal, and a browser that assumed the method exists would turn that into a
 * console error instead of a sentence.
 */
export interface ProfileBridge {
  /**
   * WO-1002 attempt 4 - THE CURRENT DEFINITION GOES WITH THE REQUEST.
   *
   * The preview has to compare TRANSLATED against TRANSLATED (completeness
   * contract 3), and only the bridge may translate (design rule 1). So the
   * bridge needs both raw sides in front of it, and the side it does not
   * already have is the machine record's. Null for a machine that has no
   * definition yet - then every `current` translation is `absent`, which is
   * the truth and not a blank.
   *
   * STILL READ-ONLY. Handing over a definition is not applying one: this call
   * parses an INI and runs the pin table, and calls no `Set*` on the board.
   */
  previewProfile(
    path: string,
    current?: ControllerDefinition | null,
  ): Promise<ProfilePreviewReply>
  /** Historical test seam only. The landed bridge deliberately has no write
   * verb beside previewProfile. */
  setBridgeProfile?(path: string): Promise<BridgeSetProfileReply>
}

/** Does this backend speak the profile half of the protocol yet? */
export function isProfileBridge(candidate: unknown): candidate is ProfileBridge {
  if (candidate === null || typeof candidate !== 'object') return false
  const c = candidate as Partial<ProfileBridge>
  return typeof c.previewProfile === 'function'
}

/** The plain sentence for a bridge that cannot preview yet. Said once, here,
 *  so the surface and the tests cannot drift into two different claims. */
export const PROFILE_BRIDGE_MISSING =
  'This bridge cannot preview a profile yet. Update the bridge before re-importing a .pro.'

/** A deployed older bridge still sits behind UccncController, so the local
 * method exists even though the remote verb does not. Classify only the
 * bridge's unknown-method refusal; transport and profile-read failures keep
 * their own, more useful error text. */
export function isMissingProfilePreviewVerbError(failure: unknown): boolean {
  const message = failure instanceof Error
    ? failure.message
    : typeof failure === 'string' ? failure : ''
  return /^the bridge does not know the method ['"]previewProfile['"]$/i.test(message.trim())
}

export const PROFILE_FILE_CHANGED =
  'The profile changed since you looked. Nothing was imported or applied; review the new preview.'

/** THE REPORT WENT STALE. A dry run is a statement about ONE record at ONE
 *  moment; the moment the values it was computed from move, its old -> new
 *  columns describe a machine that is no longer on screen, and confirming it
 *  would write numbers nobody was shown. Said once, here, so the surface and
 *  the tests cannot drift into two different claims. */
export const PROFILE_PREVIEW_STALE =
  'This machine was edited after the report was made, so the report no longer '
  + 'says what would be written. Nothing was changed. Choose the profile again '
  + 'for a fresh report.'

/**
 * WO-1002 attempt 5's audit finding - THE REPORT BELONGS TO ONE BRIDGE
 * SESSION, and a translated UCpin is a fact about a BOARD, never about a path.
 *
 * The audited sequence: preview a profile while bridge A is connected,
 * disconnect, reconnect to bridge B, and press the Confirm still on screen.
 * Every existing guard passes - the machine did not change, the record did not
 * change, the profile did not change - so the record takes bridge A's
 * translated definition and the config write goes to bridge B. THE DRY RUN
 * DESCRIBES ONE BOARD WHILE THE REQUEST REACHES ANOTHER, on the one surface
 * whose whole purpose is to stop a profile being applied unseen.
 *
 * AND RECONNECTING TO THE SAME BRIDGE IS NOT SAFE EITHER. The pin table is
 * transcribed per board; a session that comes back with a different board, a
 * different install, or a re-transcribed table answers differently for the
 * same file. So the token is the SESSION, not the path and not the board name.
 *
 * IDENTITY, NOT CONTENT, and deliberately so. Comparing what a hello frame
 * SAYS would let two sessions that happen to describe themselves alike pass
 * for one; comparing the objects the app is actually holding cannot. Three
 * halves, because the session can move in three ways a browser can see:
 *
 *   `controller`  the backend object the report was read from. A reinstalled
 *                 backend is a different object and therefore a different
 *                 session, even if nothing else moved.
 *   `hello`       the frame THAT session published. `setBridgeHello` publishes
 *                 a fresh object per hello and `setConnection('disconnected')`
 *                 nulls it, so this moves on every reconnect.
 *   `phase`       the connection phase. A drop with no reconnect still retires
 *                 the report: it describes a board nobody is talking to.
 */
export interface ProfileBridgeSession {
  controller: unknown
  hello: unknown
  phase: string | null
}

/** Is this the same live session the report was read from? Object identity on
 *  both halves, so a re-connect that rebuilt either one answers false. */
export function sameProfileBridgeSession(
  a: ProfileBridgeSession | null | undefined,
  b: ProfileBridgeSession | null | undefined,
): boolean {
  if (!a || !b) return false
  return a.controller === b.controller && a.hello === b.hello && a.phase === b.phase
}

/** THE BRIDGE MOVED UNDER THE REPORT. Said once, here, so the surface and the
 *  tests cannot drift into two different claims. */
export const PROFILE_BRIDGE_SESSION_CHANGED =
  'The bridge connection changed after this report was made, so the report no '
  + 'longer describes the board that would receive it - a translated pin is a '
  + 'fact about one board, not about a file name. Nothing was changed. Choose '
  + 'the profile again for a fresh report from the bridge now connected.'

/**
 * WO-1002 fix round 2 - THE ONE LINE SAID WHEN A REPLY FROM A DEAD SESSION IS
 * DROPPED, wherever it is dropped.
 *
 * Two audit findings in a row were the same class: an answer that came back
 * from a bridge connection that no longer exists (the PREVIEW at
 * MachineLibraryModal.tsx:703, then the CONFIG WRITE at :1054). Dropping it
 * silently is how the class stayed invisible for two rounds - the surface
 * simply looked like it had never been asked. So every drop says so, in one
 * sentence, from one place, so the console cannot carry two different accounts
 * of the same event and a test can watch for it by name.
 */
export const PROFILE_STALE_BRIDGE_REPLY_LOG =
  'a reply from the previous bridge connection was ignored'

/**
 * WO-1002 fix round - THE FIELDS A REPORT IS ABOUT, as one comparable string.
 *
 * `previewProfileChanges` reads these four from the record. Confirm writes the
 * first three back; the vacuum answer selects which imported relay the report
 * describes, so changing it also makes the old report stale. Taking the
 * fingerprint of the SAME object twice
 * gives the same string by construction, so an untouched record can never be
 * mistaken for an edited one; any edit that moves one of the three changes it.
 *
 * A machine id is NOT enough on its own - the audited defect was an edit to
 * the SAME machine between the report and the agreement - so the id check and
 * this one are both kept, and both are checked at the moment of writing.
 */
export function profileRecordFingerprint(
  target: ProfilePreviewTarget | null | undefined,
): string {
  return JSON.stringify({
    controllerDefinition: target?.controllerDefinition ?? null,
    controllerBoard: target?.controllerBoard ?? null,
    travel: target?.travel ?? null,
    toolSetter: target?.probing?.toolSetter ?? null,
    unsentSettings: target?.unsentSettings ?? null,
    coolantCapability: target?.coolantCapability ?? null,
  })
}

// ---------------------------------------------------------------------------
// THE REPORT
// ---------------------------------------------------------------------------

/**
 * ONE VALUE THE PROFILE WOULD WRITE, in the words a person reads.
 *
 * IT IS NOT A DIFF ENTRY. Every field appears, whether or not it moves, and
 * `changed` says which. The operator's question is not "what is different" but
 * "what is about to be written to my machine", and the only honest answer to
 * that is the whole list (completeness contract). A row that only exists when
 * it moves makes the absence of a row mean two different things - "this stays"
 * and "nobody looked" - and those must never share a rendering.
 *
 * PINS ARE NOT HERE. They live in `ProfilePinRow`, because a pin needs four
 * columns and not two: raw before, raw after, AND the board translation of
 * each. See `ProfilePreview.pins`.
 */
export interface ProfileChangeRow {
  /** Stable identity for a test or a key prop - `axis.X.stepsPerUnit`. */
  key: string
  /** The heading this row sits under - `X axis`, `Homing`, `Inputs`. */
  group: string
  /** The field, named the way the machine editor names it. */
  label: string
  /** What the record holds NOW. Never a guess - see `ABSENT`. */
  before: string
  /** What the profile would make it. */
  after: string
  /** Whether importing would move this value. The mark, not the filter. */
  changed: boolean
  /** Present only when this changed current value was set by this app or an
   * operator and re-import will replace it. */
  replacement?: ProfileReplacement
}

/**
 * ONE PIN, BOTH SIDES, RAW AND TRANSLATED - the row the whole order is about.
 *
 * THE COMPARISON IS `boardBefore` AGAINST `boardAfter`, never the raw pair.
 * That is what actually reaches the board (completeness contract 3), and the
 * case where the raw pair is IDENTICAL and the translation is not is the case
 * that reached a real machine: it looks like a no-op in every naive rendering,
 * so it gets `translationOnly` and a sentence of its own rather than a quiet
 * row nobody reads twice.
 *
 * `outcome` IS NEVER EMPTY. Every pin says in words what would happen to it,
 * including the ones that would have nothing happen to them, because a blank
 * cell is how "we did not look" and "this stays" become the same thing.
 */
export type PinPreviewState =
  /** The profile is SILENT about this pin. Not unchanged, not blank - its own
   *  third state, with its own sentence (completeness contract 4). */
  | 'not-in-profile'
  /** THE BOARD WILL NOT TAKE THE PROPOSED PIN. A fact about the BOARD, and
   *  emphatically not "unchanged", which would read as an all-clear on a pin
   *  that cannot work at all.
   *
   *  IT SAYS NOTHING ABOUT WHETHER THE PIN CHANGED. `REFUSED` is one of the
   *  possible RESULTS, so a pin that translated fine before and is refused
   *  now wears this state AND `changed`: known becoming unknown is the most
   *  dangerous row on this surface, not an exemption from the verdict. */
  | 'refused'
  /** One side or the other stated no result at all, so that side CANNOT BE
   *  CHECKED (completeness contract 5). That is all it says: a pin that had a
   *  good translation and would lose it is changed as well, and only a pin
   *  silent on BOTH sides is neither changed nor confirmed. */
  | 'untranslatable'
  /** The result differs. What the board gets would move - OR the pin that
   *  gets written to the machine would, which is the polarity case: `negate`
   *  is never translated, appears in no board column, and is applied on the
   *  board all the same. Both are this state. */
  | 'changed'
  /** The profile names this pin and it translates to exactly what it does
   *  now. The only state that may be called unchanged, and it is a CLAIM the
   *  profile confirmed - which is why the state above may not borrow it. */
  | 'unchanged'

export interface ProfilePinRow {
  /** `axis.X.stepPin`, `io.estop`. */
  key: string
  group: string
  label: string
  /** The wire, as a person reads it off a diagram. Context, not the verdict. */
  rawBefore: string
  rawAfter: string
  /** WHAT THE BOARD GETS. The verdict is decided on these two. */
  boardBefore: string
  boardAfter: string
  state: PinPreviewState
  /**
   * WOULD IMPORTING MOVE WHAT REACHES THE BOARD? Completeness contract 3,
   * decided on the two RESULTS - and A PIN'S RESULT IS ITS BOARD TRANSLATION
   * TOGETHER WITH THE WIRE THAT GETS WRITTEN BESIDE IT.
   *
   * THE BOARD COLUMNS ARE NOT THE WHOLE RESULT. The bridge turns port and pin
   * into a UCpin and does not translate `negate` at all: polarity is written
   * into the record and applied on the board, and the bridge's apply/readback
   * compares UCpin AND negate. So a profile that keeps a pin's port and pin
   * and flips its polarity moves what the machine does while both board
   * columns read identically - decided on the translation alone it was
   * `unchanged`, uncounted, and able to earn "nothing would change" over a
   * confirm that inverted an e-stop. That was attempt 5's audit finding.
   *
   * THE WIRE VOTES IN ONE DIRECTION ONLY: it can turn "nothing moved" into
   * "something moved" and never the reverse. Two identical raw strings are
   * not evidence that the board result stayed put - that is the hazard this
   * whole surface exists for - so a board comparison of `differs` or
   * `unknowable` keeps its own answer whatever the wire says.
   *
   * SEPARATE FROM `state` ON PURPOSE. The state answers "what did the profile
   * say about this pin"; this answers "would the board get something else".
   * They are different facts and a row must be able to carry both at once: a
   * pin the profile never mentions can still be CLEARED, REMOVED or
   * overwritten by importing it, and a state that swallowed the verdict is
   * how a report headlines "nothing would change" over a row that says a pin
   * will be cleared.
   *
   * ONE COMPARISON OVER RESULTS, WITH NO SKIP IN IT, and `REFUSED` is one of
   * the results rather than an absence of one. FALSE IN EXACTLY ONE PLACE:
   * neither side stated a board result AND the wire did not move, so nothing
   * can be claimed in either direction. Never false because the board refuses the proposed pin, never
   * false because one side is untranslatable, never false merely because the
   * profile was silent - each of those is a result that can differ from the
   * other side, and each of them failed an attempt at this order.
   */
  changed: boolean
  /** THE DANGEROUS CASE: same wire, different result. True whenever the raw
   *  pair is identical and `changed` is set, WHATEVER THE ROW'S STATE - a pin
   *  whose wiring did not move and whose board result did is the case that
   *  reached a real machine, and "identical raw but now REFUSED" is one of
   *  them (completeness contract 3). */
  translationOnly: boolean
  /** What would happen to this pin, in plain words. Never empty. */
  outcome: string
  /** Same provenance warning as a non-pin value row. */
  replacement?: ProfileReplacement
}

export interface ProfileReplacement {
  /** The report-row key, normalized from the bridge's `axes.*` vocabulary. */
  key: string
  group: string
  label: string
  before: string
  after: string
  provenance: MachineDefinitionProvenanceEntry
  source: 'app' | 'bridge'
}

/** The record a profile would be imported over. Shaped as a subset of
 *  `MachineConfig` rather than the whole thing, so this file keeps knowing
 *  nothing about CAM. */
export interface ProfilePreviewTarget {
  name?: string
  controllerBoard?: MachineControllerBoard | null
  controllerDefinition?: ControllerDefinition | null
  travel?: { x: number; y: number; z: number } | null
  probing?: Pick<MachineProbeDefaults, 'toolSetter'> | null
  /**
   * Confirm replaces this container wholesale, so it is part of what an import
   * WOULD change and therefore part of what the report has to list. Leaving it
   * out would let the record move in ways the old/new rows never showed - the
   * exact failure the dry run exists to prevent, one field-set further down
   * than anyone looked.
   */
  unsentSettings?: UnsentSetting[] | null
  /** Explicit per-value provenance when the record has it. The bridge uses
   * this same key vocabulary on Apply. Older saved records omit the map and
   * fall back to the persisted profile baseline below. */
  definitionProvenance?: MachineDefinitionProvenance | null
  /** The operator's accessory answer is not read from the profile, but when it
   * maps vacuum to M7/M8 the preview must show which imported relay that answer
   * will select. */
  coolantCapability?: MachineCoolantCapability
}

export interface ProfilePreview {
  /** False when the bridge could not read that path as a profile. `changes`
   *  is then empty and `error` says why. A caller must offer no confirm. */
  readable: boolean
  path: string
  profileName: string | null
  error: string | null
  board: { type: string | null; pinTranslation: boolean }
  /** EVERY non-pin value the import would write, old -> new, changed or not.
   *  Total by construction: the fields are a fixed list and every one of them
   *  produces a row. `changed` marks the ones that move. */
  changes: ProfileChangeRow[]
  /** EVERY PIN THE MACHINE HAS, plus every pin the profile adds, translated
   *  on both sides. Total, never a diff, never a sample - a pin missing from
   *  a preview is a pin nobody reviewed. */
  pins: ProfilePinRow[]
  /** How many rows across BOTH lists would actually move - `changed` on a
   *  value row, `changed` on a pin row, and on a pin row that verdict is the
   *  board comparison and the wiring comparison, never its state. A profile-absent pin that would
   *  be cleared counts here exactly like any other pin whose board result
   *  moves. The headline; never the filter. Zero with a full table on screen
   *  is the correct rendering of "this profile matches the machine as it is",
   *  and it may only be printed when no row below contradicts it. */
  changedCount: number
  /** Pins whose raw value is identical and whose TRANSLATION is not. The case
   *  that reached a real machine, counted separately so a surface can put it
   *  where it cannot be missed. */
  translationOnlyCount: number
  /** Pins THE BOARD REFUSES - `not-an-output` on either side - whether or not
   *  they changed. This list is a SECOND ROUTE to the same rows and not a
   *  verdict about them: a refusal must survive an otherwise-identical import,
   *  because an import that leaves such a pin exactly as it is leaves it
   *  broken, AND a pin that translated fine before and is refused now is a
   *  changed pin that also appears here. Being listed here exempts a row from
   *  nothing.
   *
   *  `unassigned` is deliberately NOT here. Nobody assigned that pin, the
   *  before/after columns already say so in those words, and forcing a row
   *  for each of them would bury the report the same way listing every
   *  unchanged value would. */
  refusals: BridgeProfilePinPreview[]
  warnings: string[]
  /** The values that would be written, if confirmed. Writing them is the
   *  CALLER's act and happens nowhere in this file. */
  definition: ControllerDefinition | null
  travel: { x: number; y: number; z: number } | null
  /** Exact app-owned board fact Confirm applies; absent only on legacy replies. */
  controllerBoard?: MachineControllerBoard | null
  toolSetter?: Partial<Vec3> | null
  unsent: UnsentSetting[]
  /** Values set by this app or an operator that Confirm will replace. */
  replacements?: ProfileReplacement[]
  /** Which list is rendered. The bridge wins only when it reports a list that
   * differs from the app's derivation. */
  replacementSource?: 'app' | 'bridge'
  replacementSourcesDiffer?: boolean
  /** WO-1670/1681/1743: macros read from the profile's macro files. The
   *  historical field name is retained because the confirmation boundary
   *  already consumes it, but these are now every M<number>.txt macro with
   *  the user's body kept verbatim, not only recognized park moves.
   *  Absent/empty = none found; Confirm then leaves the machine's own macros
   *  alone. */
  parkMacros?: MachineMacro[]
  /** G30 points proved by narrowly recognized park macros. The raw macros
   *  above remain unchanged; this is the separate, stored position fact used
   *  by the machine's existing G30 and park routes. */
  referencePositions?: MachineReferencePositions
  /** The one console row the import says about profile macros and parks. */
  parkNote?: string
}

export interface ProfileImportProvenance {
  kind: 'imported'
  sourcePath: string
  importedAt: string
  fileHash: string
}

const PROFILE_IMPORT_PROVENANCE = 'liencamProfileImportProvenance'

/** File-level provenance belongs to the stored definition, not the bridge's
 * per-value authorship map. An import is neither a `liencam-ui` edit nor an
 * out-of-band operator override. */
export function markDefinitionImported(
  definition: ControllerDefinition,
  sourcePath: string,
  fileHash: string,
  importedAt: string = new Date().toISOString(),
): ControllerDefinition {
  const imported = definition as ControllerDefinition & {
    [PROFILE_IMPORT_PROVENANCE]?: ProfileImportProvenance
  }
  imported[PROFILE_IMPORT_PROVENANCE] = {
    kind: 'imported', sourcePath, importedAt, fileHash,
  }
  return imported
}

export function definitionImportProvenance(
  definition: ControllerDefinition | null | undefined,
): ProfileImportProvenance | null {
  const imported = definition as (ControllerDefinition & {
    [PROFILE_IMPORT_PROVENANCE]?: ProfileImportProvenance
  }) | null | undefined
  return imported?.[PROFILE_IMPORT_PROVENANCE] ?? null
}

/** The record has no value for this field - said, never defaulted. */
const ABSENT = 'not in this machine'
/** The profile carries no such axis or key, so importing would drop one. */
const GONE = 'not in this profile'

const fmtNum = (n: number): string =>
  Number.isFinite(n) ? String(Number(n.toFixed(6))) : String(n)

const fmtBool = (b: boolean): string => (b ? 'yes' : 'no')

/** WO-1073 persists the imported profile's bridge-facing values on one of the
 * existing stated-key records. Reading that same carrier here lets a re-import
 * recognize LienCAM edits after Save/reload without inventing another store. */
const PROFILE_DRIFT_VALUES = 'liencamProfileDriftValues'
const PROFILE_DRIFT_PROVENANCE = 'liencamProfileDriftProvenance'
type ProfileDriftCarrier = {
  [PROFILE_DRIFT_VALUES]?: Record<string, unknown>
  [PROFILE_DRIFT_PROVENANCE]?: MachineDefinitionProvenance
}

function storedProfileDriftCarrier(
  definition: ControllerDefinition | null | undefined,
): ProfileDriftCarrier | null {
  for (const stated of definition?.stated ?? []) {
    const carrier = stated as typeof stated & ProfileDriftCarrier
    if (carrier[PROFILE_DRIFT_VALUES] || carrier[PROFILE_DRIFT_PROVENANCE]) return carrier
  }
  return null
}

/** The report's row keys predate the bridge drift vocabulary. Normalize at the
 * boundary so one provenance entry can mark the exact row a person will read. */
const PREVIEW_AXIS_FIELD_FROM_DRIFT_FIELD = new Map([
  ['backlash.enabled', 'backlashEnabled'],
  ['backlash.distance', 'backlashDistance'],
])

const DRIFT_AXIS_FIELD_FROM_PREVIEW_FIELD = new Map([
  ['backlashEnabled', 'backlash.enabled'],
  ['backlashDistance', 'backlash.distance'],
])

function previewKeyFromDriftKey(key: string): string {
  const axis = /^axes\.([A-Z])\.(.+)$/.exec(key)
  if (!axis) return key
  const [, name, field] = axis
  return field.startsWith('homing.')
    ? `homing.${name}.${field.slice('homing.'.length)}`
    : `axis.${name}.${PREVIEW_AXIS_FIELD_FROM_DRIFT_FIELD.get(field) ?? field}`
}

function driftKeyFromPreviewKey(key: string): string {
  const axis = /^axis\.([A-Z])\.(.+)$/.exec(key)
  if (axis) {
    const field = DRIFT_AXIS_FIELD_FROM_PREVIEW_FIELD.get(axis[2]) ?? axis[2]
    return `axes.${axis[1]}.${field}`
  }
  const homing = /^homing\.([A-Z])\.(.+)$/.exec(key)
  if (homing) return `axes.${homing[1]}.homing.${homing[2]}`
  return key
}

function fmtDriftValue(value: unknown): string {
  if (typeof value === 'number') return fmtNum(value)
  if (typeof value === 'boolean') return fmtBool(value)
  if (value === null) return 'none'
  if (
    typeof value === 'object' && value !== null
    && typeof (value as Partial<PinRef>).port === 'number'
    && typeof (value as Partial<PinRef>).pin === 'number'
  ) return fmtPin(value as PinRef)
  return String(value)
}

type ReplacementRow = ProfileChangeRow | ProfilePinRow

function replacementBefore(row: ReplacementRow): string {
  return 'before' in row ? row.before : row.rawBefore
}

function replacementAfter(row: ReplacementRow): string {
  return 'after' in row ? row.after : row.rawAfter
}

function appProfileReplacements(
  current: ProfilePreviewTarget | null | undefined,
  rows: readonly ReplacementRow[],
): ProfileReplacement[] {
  const carrier = storedProfileDriftCarrier(current?.controllerDefinition)
  const baseline = carrier?.[PROFILE_DRIFT_VALUES] ?? {}
  const stored = carrier?.[PROFILE_DRIFT_PROVENANCE] ?? {}
  const explicit = current?.definitionProvenance ?? {}
  const fallbackSource = current?.name
    ? `${current.name} - LienCAM definition editor`
    : 'LienCAM definition editor'

  return rows.flatMap((row): ProfileReplacement[] => {
    if (!row.changed) return []
    const driftKey = driftKeyFromPreviewKey(row.key)
    let provenance = explicit[driftKey] ?? stored[driftKey]
    if (!provenance && Object.prototype.hasOwnProperty.call(baseline, driftKey)) {
      const profileValue = fmtDriftValue(baseline[driftKey])
      if (profileValue !== replacementBefore(row)) {
        provenance = { kind: 'liencam-ui', source: fallbackSource }
      }
    }
    if (!provenance) return []
    return [{
      key: row.key,
      group: row.group,
      label: row.label,
      before: replacementBefore(row),
      after: replacementAfter(row),
      provenance,
      source: 'app',
    }]
  })
}

function canonicalReplacementList(rows: readonly ProfileReplacement[]): string[] {
  return rows.map((row) => [
    row.key, row.before, row.after, row.provenance.kind, row.provenance.source,
  ].join('\u0000')).sort()
}

function sameReplacementList(
  left: readonly ProfileReplacement[],
  right: readonly ProfileReplacement[],
): boolean {
  const a = canonicalReplacementList(left)
  const b = canonicalReplacementList(right)
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function markProfileReplacements(
  current: ProfilePreviewTarget | null | undefined,
  reply: BridgeProfilePreviewReply,
  changes: ProfileChangeRow[],
  pins: ProfilePinRow[],
): Pick<ProfilePreview, 'replacements' | 'replacementSource' | 'replacementSourcesDiffer'> {
  const rows: ReplacementRow[] = [...changes, ...pins]
  const byKey = new Map(rows.map((row) => [row.key, row] as const))
  const app = appProfileReplacements(current, rows)
  const bridge = reply.replaced?.map((entry): ProfileReplacement => {
    const key = previewKeyFromDriftKey(entry.key)
    const row = byKey.get(key)
    return {
      key,
      group: row?.group ?? 'Bridge-reported value',
      label: row?.label ?? entry.key,
      before: entry.ours,
      after: entry.profile,
      provenance: entry.provenance,
      source: 'bridge',
    }
  })
  const differs = bridge !== undefined && !sameReplacementList(app, bridge)
  const replacements = differs ? bridge : app
  const replacementSource = differs ? 'bridge' : 'app'
  const replacementByKey = new Map(replacements.map((row) => [row.key, row] as const))
  for (const row of rows) row.replacement = replacementByKey.get(row.key)
  return { replacements, replacementSource, replacementSourcesDiffer: differs }
}

/** A pin as a person reads it off a wiring diagram, with polarity stated as
 *  three values and not two: `null` negate means NOBODY HAS SAID, and
 *  rendering that as "not inverted" would be the fabricated claim
 *  `PinRef.negate` exists to refuse (types/index.ts:202-212).
 *
 *  THIS COLUMN LIES BY ITSELF IN ONE DIRECTION: two identical strings here
 *  can still be two different board pins, which is why it is never the
 *  comparison on its own. IT IS NOT MERE CONTEXT EITHER - polarity is written
 *  to the machine and appears in no board column - so two DIFFERENT strings
 *  here are a real change even when the board columns agree (`compareWiring`,
 *  WO-1002 attempt 5). */
const fmtPin = (p: PinRef | undefined): string => {
  if (!p || (p.port === 0 && p.pin === 0)) return 'unassigned'
  const polarity = p.negate === null || p.negate === undefined
    ? 'polarity not stated'
    : p.negate ? 'inverted' : 'not inverted'
  return `port ${p.port} pin ${p.pin}, ${polarity}`
}

/**
 * Did the bridge STATE a result for this side of this pin?
 *
 * A stated result is one a person can act on: a board pin number, "no board
 * pin", "the board refuses this pin", "there is no such pin". `REFUSED IS A
 * STATED RESULT` and not an absence of one - the board has said what will
 * happen, and what will happen is nothing. That is the whole hinge of the
 * completeness contract's table.
 *
 * `ok` WITHOUT a number is NOT stated - the bridge said it translated and
 * declined to say to what - and neither is `untranslatable` or a pin the
 * bridge never mentioned. Those are silences, and two silences are not
 * evidence that a pin stayed the same.
 */
function translationStated(t: BridgeProfilePinTranslation): boolean {
  if (t.status === 'ok') return typeof t.ucPin === 'number'
  return t.status === 'unassigned' || t.status === 'not-an-output' || t.status === 'absent'
}

/** The comparable form of one translation. Only ever called on a stated one. */
function translationKey(t: BridgeProfilePinTranslation): string {
  return t.status === 'ok' ? `ok:${String(t.ucPin)}` : t.status
}

/**
 * THE ONE COMPARISON, AND THERE IS NO SKIP IN IT.
 *
 * WO-1002 completeness contract: compare the RESULTS, and treat `REFUSED` as
 * one of the possible results rather than as an absence of one. Every pair
 * whose results differ is CHANGED, whatever the raw values did.
 *
 * THREE ANSWERS BECAUSE THERE ARE THREE, and collapsing them to two is how
 * four attempts of this order failed:
 *
 *   'same'       both sides stated the same result. The ONLY answer that may
 *                be rendered as unchanged, and it is a claim, not a default.
 *   'differs'    the results are not the same result. This includes
 *                `UCpin 302` -> REFUSED and `UCpin 302` -> "cannot be
 *                translated": A PIN WHOSE BEHAVIOUR HAS GONE FROM KNOWN TO
 *                UNKNOWN HAS CHANGED, and rendering it as a no-op is the
 *                most dangerous row on this whole surface (attempt 4's hole,
 *                and its twin one status over).
 *   'unknowable' NEITHER side stated a result. Nothing can be claimed in
 *                either direction, so the row is not called changed - but it
 *                is not called unchanged either. This, and only this, is what
 *                "do not mark a pin changed MERELY because it is
 *                untranslatable" means.
 *
 * There is deliberately no `status === 'untranslatable'` test in here as a
 * reason to abandon the comparison. That shape was the defect.
 */
type ResultVerdict = 'same' | 'differs' | 'unknowable'

function compareResults(
  current: BridgeProfilePinTranslation, proposed: BridgeProfilePinTranslation,
): ResultVerdict {
  const currentStated = translationStated(current)
  const proposedStated = translationStated(proposed)
  if (currentStated && proposedStated) {
    return translationKey(current) === translationKey(proposed) ? 'same' : 'differs'
  }
  // One side says what reaches the board and the other says nothing at all.
  // Known -> unknown, or unknown -> known: the result is not the same result.
  if (currentStated !== proposedStated) return 'differs'
  return 'unknowable'
}

/**
 * The bridge's word on one side of one pin, PRINTED AND NEVER DERIVED.
 *
 * Every status but `ok` prints WORDS. A pin the bridge cannot translate never
 * falls back to a number (completeness contract 5) and a missing entry never
 * renders blank - "the bridge did not say" is a thing a person can act on and
 * an empty cell is not.
 */
function fmtTranslation(
  t: BridgeProfilePinTranslation, side: 'now' | 'after',
): string {
  switch (t.status) {
    case 'ok':
      return typeof t.ucPin === 'number'
        ? `UCpin ${t.ucPin}`
        : 'the bridge translated this pin and did not say to what'
    case 'unassigned':
      return 'unassigned - no board pin'
    case 'not-an-output':
      return 'the board REFUSES this pin: not an output'
    case 'untranslatable':
      return t.detail === null || t.detail === ''
        ? 'cannot be translated on this board'
        : `cannot be translated: ${t.detail}`
    case 'absent':
      return side === 'now' ? ABSENT : GONE
    default:
      return 'the bridge did not say'
  }
}

/** What a bridge that never mentioned this pin has told us: nothing. Built
 *  here rather than left undefined, so an omission becomes a listed row that
 *  says it is unknown instead of a pin that quietly does not exist. */
const UNREPORTED: BridgeProfilePinTranslation = {
  ucPin: null, status: 'unreported', detail: null,
}

interface AxisField {
  key: string
  label: string
  read: (a: AxisDefinition) => string
}

const AXIS_FIELDS: readonly AxisField[] = [
  { key: 'enabled',          label: 'axis enabled',             read: (a) => fmtBool(a.enabled) },
  { key: 'stepsPerUnit',     label: 'steps per unit',           read: (a) => fmtNum(a.stepsPerUnit) },
  { key: 'maxVelocity',      label: 'max velocity (units/min)', read: (a) => fmtNum(a.maxVelocity) },
  { key: 'acceleration',     label: 'acceleration (units/s2)',  read: (a) => fmtNum(a.acceleration) },
  { key: 'softLimitMin',     label: 'soft limit minus',         read: (a) => fmtNum(a.softLimitMin) },
  { key: 'softLimitMax',     label: 'soft limit plus',          read: (a) => fmtNum(a.softLimitMax) },
  { key: 'slaveAxis',        label: 'slave axis',               read: (a) => a.slaveAxis ?? 'none' },
  { key: 'enableDelayMs',    label: 'enable delay (ms)',        read: (a) => fmtNum(a.enableDelayMs) },
  { key: 'backlashEnabled',  label: 'backlash compensation',    read: (a) => fmtBool(a.backlash.enabled) },
  { key: 'backlashDistance', label: 'backlash distance',        read: (a) => fmtNum(a.backlash.distance) },
]

/** THE PIN FIELDS, split out of `AXIS_FIELDS` on purpose. A pin needs four
 *  columns and not two, so it produces a `ProfilePinRow` and never a
 *  `ProfileChangeRow`. Reached through `ProfilePreview.pins`. */
const AXIS_PIN_FIELDS: readonly {
  key: string; label: string; read: (a: AxisDefinition) => PinRef | undefined
}[] = [
  { key: 'stepPin',       label: 'step pin',        read: (a) => a.stepPin },
  { key: 'dirPin',        label: 'direction pin',   read: (a) => a.dirPin },
  { key: 'homePin',       label: 'home pin',        read: (a) => a.homePin },
  { key: 'limitMinusPin', label: 'limit minus pin', read: (a) => a.limitMinusPin },
  { key: 'limitPlusPin',  label: 'limit plus pin',  read: (a) => a.limitPlusPin },
  { key: 'enablePin',     label: 'enable pin',      read: (a) => a.enablePin },
]

const IO_PIN_FIELDS = [
  ['estop', 'e-stop input'],
  ['probe', 'probe input'],
  ['probe2', 'probe 2 input'],
] as const

const HOMING_FIELDS: readonly {
  key: string; label: string; read: (h: AxisHomingDefinition) => string
}[] = [
  { key: 'direction',   label: 'homing direction',  read: (h) => h.direction },
  { key: 'fastSpeed',   label: 'homing fast speed', read: (h) => fmtNum(h.fastSpeed) },
  { key: 'slowSpeed',   label: 'homing slow speed', read: (h) => fmtNum(h.slowSpeed) },
  { key: 'backOff',     label: 'homing back off',   read: (h) => fmtNum(h.backOff) },
  { key: 'homingValue', label: 'homing value',      read: (h) => fmtNum(h.homingValue) },
  { key: 'autoZero',    label: 'homing auto zero',  read: (h) => fmtBool(h.autoZero) },
]

/**
 * ONE ROW, ALWAYS. There is no early return here any more and that is the
 * whole point of attempt 4: a row that only exists when the value moves makes
 * "no row" mean both "this stays as it is" and "nobody looked at this", and
 * those two must never share a rendering.
 */
function pushChange(
  rows: ProfileChangeRow[],
  key: string, group: string, label: string, before: string, after: string,
): void {
  rows.push({ key, group, label, before, after, changed: before !== after })
}

// ---------------------------------------------------------------------------
// THE PIN ROW - where translated meets translated
// ---------------------------------------------------------------------------

/**
 * COMPARE THE WIRE ITSELF, as the two cells actually print it.
 *
 * THE BOARD COLUMNS ARE NOT THE WHOLE RESULT (WO-1002 attempt 5's audit
 * finding). The bridge translates port and pin into a UCpin; POLARITY IS NOT
 * TRANSLATED AT ALL - `negate` is written into the machine record and applied
 * on the board, and the bridge's own apply/readback compares UCpin AND negate.
 * So a profile that keeps a pin's port and pin and flips its polarity moves
 * what the machine does while both board columns read identically. Compared on
 * the translation alone that row said `unchanged`, was left out of the count,
 * and could earn the headline that nothing would change over a confirm that
 * inverted an e-stop.
 *
 * IT COMPARES THE RENDERED CELLS ON PURPOSE, so this verdict can never
 * contradict the row it annotates: if the two wiring columns print the same
 * words the wire did not move, and if they print different words it did.
 *
 * `null` IS "THERE IS NO SUCH PIN ON THIS SIDE" - a machine with no
 * definition, an axis the profile does not carry. Nothing is compared then and
 * nothing is claimed; the board comparison already speaks for that case, and
 * inventing a difference out of "not in this machine" against "not in this
 * profile" would be exactly the fabricated fact this file refuses to make.
 */
function compareWiring(before: string | null, after: string | null): ResultVerdict {
  if (before === null || after === null) return 'unknowable'
  return before === after ? 'same' : 'differs'
}

/**
 * Decide, in words, what would happen to one pin.
 *
 * TWO ANSWERS, NOT ONE, AND THEY DO NOT OVERRULE EACH OTHER. `state` says
 * what the PROFILE said about this pin; `changed` says whether what reaches
 * the BOARD would move. Attempt 4 collapsed them and lost the second: a pin
 * the profile never named still got `not-in-profile` and was thereby counted
 * unchanged even when its own sentence said importing would CLEAR it.
 *
 * FIVE STATES AND NOT TWO, AND NONE OF THEM DECIDES `changed`.
 * `not-in-profile` outranks the others, because a silent profile has
 * confirmed nothing and no other sentence may be attached to a pin it never
 * named - but it outranks them as a SENTENCE only. `refused` and
 * `untranslatable` likewise: they say WHAT the result is, and the comparison
 * above has already said whether it MOVED. A state that overrules the verdict
 * is how attempts 3 and 4 each shipped a row that changed the board and wore
 * no change mark.
 *
 * THE RESULT IS THE BOARD TRANSLATION AND THE WIRE THAT GETS WRITTEN, and the
 * wire half is where `negate` lives - the part the bridge does not translate
 * and the part that decides whether a switch reads asserted or released. Both
 * halves are compared; see `compareWiring`.
 */
function pinRowFor(
  key: string, group: string, label: string,
  /** THE WIRING COLUMNS, ALREADY RENDERED - what the row will actually print,
   *  so the verdict below is computed off the same words the operator reads.
   *  `null` means THIS SIDE HAS NO SUCH PIN AT ALL, which prints as "not in
   *  this machine" / "not in this profile" and is compared as nothing. */
  wireBefore: string | null, wireAfter: string | null,
  entry: BridgeProfilePinPreview | undefined,
): ProfilePinRow {
  const current = entry?.current ?? UNREPORTED
  const proposed = entry?.proposed ?? UNREPORTED
  const rawBefore = wireBefore ?? ABSENT
  const rawAfter = wireAfter ?? GONE
  const boardBefore = fmtTranslation(current, 'now')
  const boardAfter = fmtTranslation(proposed, 'after')
  const sameRaw = rawBefore === rawAfter

  // THE CHANGE VERDICT, DECIDED ONCE, ON THE RESULTS, BEFORE ANY STATE IS
  // CHOSEN - so that no state can quietly answer this question instead.
  //
  // TWO HALVES, BECAUSE THE RESULT HAS TWO HALVES: what the board translation
  // becomes, and what gets written on the wire beside it. The board half is
  // the primary one; the wire half exists because POLARITY NEVER APPEARS IN
  // THE BOARD COLUMNS and is applied to the machine all the same.
  //
  // THE WIRE MAY ONLY VOTE ONE WAY. It can turn "nothing moved" into
  // "something moved"; it can NEVER turn a `differs` or an `unknowable` into
  // a `same`. Two identical raw strings are not evidence that the board
  // result stayed put - that is the hazard this entire surface was built for
  // (contract rule 3) - so a board comparison that says anything but `same`
  // keeps its own answer.
  //
  // FALSE IN EXACTLY ONE PLACE: neither side stated a board result AND the
  // wire did not move, so there is nothing to compare in either direction.
  // That row is not called unchanged either - it gets the `untranslatable`
  // state and its own sentence below.
  //
  // NOT FALSE because the board refuses the proposed pin: a pin going from a
  // good translation to a refusal has gone from known to unknown, and that
  // is a change of exactly the kind this preview exists to show.
  // NOT FALSE because the profile was silent: that is a fact about the
  // profile, not about the board.
  const board = compareResults(current, proposed)
  const wiring = compareWiring(wireBefore, wireAfter)
  const verdict: ResultVerdict =
    board === 'differs' || wiring === 'differs' ? 'differs' : board
  const changed = verdict === 'differs'
  const nothingMoves = verdict === 'same'

  // THE MIRROR OF RULE 3, AND THE ROW ATTEMPT 5 WAS FAILED FOR. The board
  // columns are identical (or unknowable) and the WIRE moves - a polarity
  // flip is the whole of this case. It reads as a no-op in the two columns
  // this table calls the verdict, so every branch below gets its own sentence
  // for it rather than falling through to "the board would change", which
  // would print `UCpin 302 becomes UCpin 302`.
  const wiringOnly = changed && board !== 'differs'

  // STATE ROUTING ONLY, NEVER THE VERDICT. `bothStated` picks which SENTENCE
  // a row gets; `changed` above has already decided whether the board moves.
  // A pin with one side unstated is still `CANNOT BE CHECKED` - the operator
  // needs to know a side is unknown - and it wears the change mark as well
  // when the other side did state a result.
  const bothStated = translationStated(current) && translationStated(proposed)

  // RULE 3, APPLIED TO EVERY STATE AND NOT JUST TO `changed`. Identical
  // wiring with a different result is the case that reached a real machine -
  // it looks like a no-op in any rendering that reads the raw columns - and
  // "identical raw but now REFUSED" is named in the contract as one of them.
  const translationOnly = changed && sameRaw

  // The bridge reporting nothing about a pin is not a statement that the
  // profile is silent about it. An omission says neither, so a pin with no
  // entry falls through to `untranslatable` below rather than being called
  // "not in this profile" - claiming that off a missing entry would be
  // inventing the very fact this file refuses to invent.
  if (entry !== undefined && !entry.inProfile) {
    const outcome = verdict === 'unknowable'
      ? 'THIS PROFILE DOES NOT MENTION THIS PIN, and the bridge could not say '
        + 'what it holds now or what it would become. Nothing here confirms it.'
      : wiringOnly
        ? 'THIS PROFILE DOES NOT MENTION THIS PIN, and importing would still '
          + `change the pin that gets written: ${rawBefore} becomes `
          + `${rawAfter}. READ THE WIRING COLUMNS - the board columns do not `
          + 'show this one. Nothing in the profile confirmed that value.'
        : !bothStated
          ? 'THIS PROFILE DOES NOT MENTION THIS PIN, and importing would leave '
            + `it in a state nobody can check: ${boardBefore} becomes `
            + `${boardAfter}. Nothing here confirms it.`
          : proposed.status === 'not-an-output'
            ? 'THIS PROFILE DOES NOT MENTION THIS PIN, and the board REFUSES it: '
              + 'it is not an output. Importing would leave it broken.'
            : nothingMoves
              ? 'THIS PROFILE DOES NOT MENTION THIS PIN. Importing would leave it '
                + 'exactly as it is - but nothing in the profile confirmed that value.'
              : proposed.status === 'absent'
                ? 'THIS PROFILE DOES NOT MENTION THIS PIN, so importing would '
                  + 'REMOVE it: the machine would be left with no such pin at all.'
                : proposed.status === 'unassigned'
                  ? 'THIS PROFILE DOES NOT MENTION THIS PIN, so importing would '
                    + 'CLEAR it: the machine would have no board pin here at all.'
                  : 'THIS PROFILE DOES NOT MENTION THIS PIN, and importing would '
                    + `still overwrite it with ${boardAfter}. Nothing in the `
                    + 'profile confirmed that value.'
    return {
      key, group, label, rawBefore, rawAfter, boardBefore, boardAfter,
      state: 'not-in-profile', changed, translationOnly, outcome,
    }
  }

  // ONE SIDE OR THE OTHER SAID NOTHING. The state is `CANNOT BE CHECKED`
  // either way, because the operator has to know a side is unknown - but the
  // CHANGE VERDICT still stands beside it, and the sentences below are
  // different sentences for a reason:
  //
  //   both silent   nothing can be claimed about the BOARD in either
  //                 direction. Not changed on that evidence, and emphatically
  //                 not confirmed - unless the WIRE moved, which is a fact
  //                 nobody needed the board to state.
  //   one silent    KNOWN -> UNKNOWN (or back). The pin's behaviour moved
  //                 from a stated result to no result at all, which is a
  //                 change, and it is the row this whole surface exists for.
  if (!bothStated) {
    const side = !translationStated(proposed) ? boardAfter : boardBefore
    return {
      key, group, label, rawBefore, rawAfter, boardBefore, boardAfter,
      state: 'untranslatable',
      changed,
      translationOnly,
      outcome: wiringOnly
        ? `READ THIS ONE. Nobody can say what this pin does on the board `
          + `(${side}), and importing would change the pin that gets written `
          + `anyway: ${rawBefore} becomes ${rawAfter}. Unknown on the board `
          + 'and moved on the wire is not a no-op.'
        : verdict === 'unknowable'
          ? `THIS PIN CANNOT BE CHECKED: ${side}. Nobody can say what it would `
            + 'do on the board, so it is not counted as changed and it is not '
            + 'confirmed either.'
          : !translationStated(proposed)
            ? `READ THIS ONE. This pin does something known on the board now `
              + `(${boardBefore}) and importing would leave it in a state nobody `
              + `can check: ${boardAfter}. Known becomes unknown - that is a `
              + 'change, not a no-op.'
            : `This pin cannot be checked as it stands (${boardBefore}) and `
              + `importing would give it a result that can: ${boardAfter}. That `
              + 'is a change.',
    }
  }

  // A PIN THE BOARD REFUSES, WHETHER OR NOT ANYTHING ABOUT IT MOVED. The
  // record and the profile can agree perfectly and the pin still cannot be
  // written, so an identical import leaves it exactly as broken as it was.
  // Checked BEFORE `nothingMoves`, because "unchanged" on a pin the board will
  // not take is an all-clear on a pin that cannot work.
  //
  // REFUSAL IS A RESULT, NOT AN EXEMPTION (completeness contract, attempt 4's
  // hole). Reaching this branch says what the proposed result IS; it says
  // nothing about whether the result MOVED, so `changed` is passed straight
  // through and the outcome sentence is chosen to match it.
  if (proposed.status === 'not-an-output') {
    return {
      key, group, label, rawBefore, rawAfter, boardBefore, boardAfter,
      state: 'refused',
      changed,
      translationOnly,
      outcome: !changed
        ? 'THE BOARD REFUSES THIS PIN: it is not an output. Importing '
          + 'this profile would not fix that and would not change it - the pin '
          + 'stays unusable until the wiring or the board changes.'
        : wiringOnly
          ? 'THE BOARD REFUSES THIS PIN: it is not an output, before and '
            + 'after. Importing would not fix that AND WOULD STILL REWRITE THE '
            + `PIN: ${rawBefore} becomes ${rawAfter}. It stays unusable, and it `
            + 'does not stay as it is - the board columns do not show this one.'
          : sameRaw
            ? `READ THIS ONE. The wiring is identical (${rawAfter}) and the `
              + `result is NOT: this pin does ${boardBefore} now, and importing `
              + 'would leave THE BOARD REFUSING IT: it is not an output. It '
              + 'looks untouched on screen and it would stop working.'
            : `READ THIS ONE. This pin does ${boardBefore} now, and importing `
              + 'would leave THE BOARD REFUSING IT: it is not an output. A '
              + 'working pin would become an unusable one.',
    }
  }

  if (nothingMoves) {
    // THE SENTENCE MAY NOT CONTRADICT ITS OWN COLUMNS. `absent` is one result
    // that PRINTS differently on the two sides - "not in this machine" now,
    // "not in this profile" after - so the ordinary unchanged sentence would
    // claim the profile names a pin while the column beside it says the
    // profile has no such pin. Nothing moves either way, which is why this is
    // still not a changed row, but a row is never allowed to say a thing its
    // own cells deny.
    const neitherSideHasIt =
      current.status === 'absent' && proposed.status === 'absent'
    return {
      key, group, label, rawBefore, rawAfter, boardBefore, boardAfter,
      state: 'unchanged',
      changed,
      translationOnly,
      outcome: neitherSideHasIt
        ? 'THERE IS NO SUCH PIN, on this machine or in this profile. Importing '
          + 'would neither add it nor take it away, and nothing here is a claim '
          + 'that the pin was checked.'
        : 'The profile names this pin and it translates to what it does '
          + `now (${boardAfter}). Importing would change nothing on the board here.`,
    }
  }

  // THE CASE THAT REACHED A REAL MACHINE. Identical on the wiring diagram,
  // different on the board. It reads as a no-op in any rendering that compares
  // raw values, which is why it gets its own flag and its own sentence.
  if (sameRaw) {
    return {
      key, group, label, rawBefore, rawAfter, boardBefore, boardAfter,
      state: 'changed',
      changed,
      translationOnly,
      outcome: `READ THIS ONE. The wiring is identical (${rawAfter}) and the `
        + `board pin is NOT: ${boardBefore} becomes ${boardAfter}. Importing `
        + 'would change what reaches the board while the pin on screen looks '
        + 'untouched.',
    }
  }

  // AND ITS MIRROR: the board columns are identical and THE WIRE IS NOT.
  // Polarity is the case - it is written to the machine, the bridge applies
  // it and compares it on readback, and it appears in no board column at all.
  // A row like this looked like a no-op to every earlier attempt at this file.
  if (wiringOnly) {
    return {
      key, group, label, rawBefore, rawAfter, boardBefore, boardAfter,
      state: 'changed',
      changed,
      translationOnly,
      outcome: `READ THIS ONE. The board pin does not move (${boardAfter}) and `
        + `THE PIN THAT WOULD BE WRITTEN DOES: ${rawBefore} becomes `
        + `${rawAfter}. Polarity is written to the machine and never appears `
        + 'in the board columns, so this row looks like a no-op there - and an '
        + 'inverted limit or e-stop reports the opposite of what the switch is '
        + 'doing.',
    }
  }

  return {
    key, group, label, rawBefore, rawAfter, boardBefore, boardAfter,
    state: 'changed',
    changed,
    translationOnly,
    outcome: `Importing would change what reaches the board: ${boardBefore} `
      + `becomes ${boardAfter}.`,
  }
}

/** Runtime boundary for the landed bridge reply. Socket data is not trusted
 * merely because UccncController gave the call a TypeScript return type. */
export function isBridgePreviewProfileReply(
  reply: ProfilePreviewReply | unknown,
): reply is BridgePreviewProfileReply {
  if (reply === null || typeof reply !== 'object') return false
  const value = reply as Partial<BridgePreviewProfileReply>
  return typeof value.ok === 'boolean'
    && (value.reason === null || typeof value.reason === 'string')
    && typeof value.path === 'string'
    && (value.fileHash === null || typeof value.fileHash === 'string')
    && Array.isArray(value.settings)
    && value.settings.every((setting) => {
      if (setting === null || typeof setting !== 'object') return false
      const row = setting as Partial<BridgeProfileSetting>
      return typeof row.section === 'string'
        && typeof row.key === 'string'
        && typeof row.value === 'string'
    })
}

/** Rebuild the INI-shaped input the existing importer consumes. Sections are
 * kept in first-seen order and assignments retain their file order, including
 * duplicates. The importer's Map then matches UCCNC's last-key-wins loader. */
export function bridgeProfileSettingsText(settings: readonly BridgeProfileSetting[]): string {
  const sections = new Map<string, { name: string; rows: BridgeProfileSetting[] }>()
  for (const setting of settings) {
    const id = setting.section.toLowerCase()
    const found = sections.get(id)
    if (found) found.rows.push(setting)
    else sections.set(id, { name: setting.section, rows: [setting] })
  }
  const lines: string[] = []
  for (const section of sections.values()) {
    lines.push(`[${section.name}]`)
    for (const setting of section.rows) lines.push(`${setting.key}=${setting.value}`)
  }
  return lines.join('\n')
}

function annotateDuplicateProfileSettings(
  preview: ProfilePreview,
  settings: readonly BridgeProfileSetting[],
): void {
  const occurrences = new Map<string, BridgeProfileSetting[]>()
  for (const setting of settings) {
    const id = `${setting.section.toLowerCase()}\u0000${setting.key.toLowerCase()}`
    const rows = occurrences.get(id)
    if (rows) rows.push(setting)
    else occurrences.set(id, [setting])
  }
  for (const rows of occurrences.values()) {
    if (rows.length < 2) continue
    const last = rows[rows.length - 1]
    const effectiveKey = `${last.section}.${last.key}`.toLowerCase()
    const effective = preview.changes.find((row) => row.key.toLowerCase() === effectiveKey)
    if (effective) effective.label += ` (last of ${rows.length} duplicates; UCCNC uses this one)`
    rows.forEach((setting, index) => {
      preview.changes.push({
        key: `file-duplicate.${setting.section}.${setting.key}.${index + 1}`,
        group: `${setting.section} settings`,
        label: `${setting.section}.${setting.key} (file occurrence ${index + 1} of ${rows.length}; `
          + `UCCNC uses occurrence ${rows.length})`,
        before: setting.value,
        after: setting.value,
        changed: false,
      })
    })
  }
}

/** Adapt the landed raw tuple reply into the existing preview model. The
 * historical rich reply remains supported for its translation regression
 * tests, but no real bridge is required to manufacture a TypeScript object. */
export function previewBridgeProfileChanges(
  current: ProfilePreviewTarget | null | undefined,
  reply: ProfilePreviewReply,
): ProfilePreview {
  if (!isBridgePreviewProfileReply(reply)) return previewProfileChanges(current, reply)

  if (!reply.ok) {
    return previewProfileChanges(current, {
      ok: false,
      error: reply.reason ?? 'The bridge could not read this profile.',
      path: reply.path,
      profileName: null,
      board: { type: null, pinTranslation: false },
      definition: null,
      travel: null,
      pins: [],
      unsent: [],
      warnings: [],
    })
  }

  const imported = importUccncProfile(bridgeProfileSettingsText(reply.settings))
  const preview = previewProfileChanges(current, {
    ok: imported.definition !== null,
    error: imported.definition === null
      ? imported.issues.map((issue) => `${issue.key}: ${issue.message}`).join('; ')
      : null,
    path: reply.path,
    profileName: imported.profileName,
    board: { type: null, pinTranslation: false },
    definition: imported.definition,
    travel: imported.travel,
    controllerBoard: imported.controllerBoard,
    toolSetter: imported.toolSetter,
    pins: [],
    unsent: imported.unsent,
    warnings: imported.issues.map((issue) => `${issue.key}: ${issue.message}`),
  })
  annotateDuplicateProfileSettings(preview, reply.settings)
  return preview
}

/**
 * Build the same total, read-only report for a `.pro` selected from disk.
 * There is deliberately no bridge session or board translation here: a local
 * file is only a source for LienCAM's editable record, never a controller act.
 */
export function previewLocalUccncProfile(
  current: ProfilePreviewTarget | null | undefined,
  filename: string,
  text: string,
  macros: readonly UccncMacroFile[] = [],
): ProfilePreview {
  const preview = previewLocalUccncProfileFile(current, filename, text)
  if (!preview.readable) return preview
  const importedMacros = macrosFromUccncFiles(macros)
  const parks = parksFromUccncMacros(macros)
  return {
    ...preview,
    parkMacros: importedMacros,
    referencePositions: referencePositionsFromUccncParks(parks),
    parkNote: `${describeImportedMacros(importedMacros, macros.length)} ${describeImportedParks(parks, macros.length)}`,
  }
}

function previewLocalUccncProfileFile(
  current: ProfilePreviewTarget | null | undefined,
  filename: string,
  text: string,
): ProfilePreview {
  const imported = importUccncProfile(text)
  const gaps = unimportedUccncProfileFields(imported)
  const warnings = imported.issues.map(
    (issue) => `Profile warning - ${issue.key}: ${issue.message}`,
  )
  if (imported.definition) {
    const unmodelled = new Set(imported.unmodelled)
    warnings.push(...(gaps.length === 0
      ? ['Not imported - none. Every machine-definition field present in this file was understood.']
      : gaps.map((key) => unmodelled.has(key)
        ? `Not imported - ${key}: the profile stated this setting, but LienCAM does not model it; its original profile text will be preserved.`
        : `Not imported - ${key}: the profile did not state a usable value.`)))
  }

  return previewProfileChanges(current, {
    ok: imported.definition !== null,
    error: imported.definition === null
      ? imported.issues.map((issue) => `${issue.key}: ${issue.message}`).join('; ')
      : null,
    path: filename,
    profileName: imported.profileName,
    board: { type: 'local file', pinTranslation: false },
    definition: imported.definition,
    travel: imported.travel,
    controllerBoard: imported.controllerBoard,
    toolSetter: imported.toolSetter,
    pins: [],
    unsent: imported.unsent,
    warnings,
  })
}

/**
 * Say what applying `reply` over `current` WOULD change.
 *
 * Nothing here writes. `current` is read and never mutated; the returned
 * `definition` is the bridge's own object, so a caller that keeps the preview
 * and never confirms has left the record byte for byte as it was.
 *
 * PREVIEW AND IMPORT CANNOT DIVERGE, because this does not re-implement the
 * translation - it describes what the bridge reported, and the `definition` a
 * caller writes on confirm is the same object the change rows were computed
 * from. There is no second parse and no second mapping.
 *
 * IT IS TOTAL, NOT A DIFF (WO-1002 completeness contract). Every field and
 * every pin produces a row whether or not it moves, `changed` marks the ones
 * that do, and `changedCount` is the headline. The operator's question is not
 * "what is different" but "what is about to be written to my machine", and the
 * only honest answer to that is the whole list.
 */
export function previewProfileChanges(
  current: ProfilePreviewTarget | null | undefined,
  reply: BridgeProfilePreviewReply,
): ProfilePreview {
  const changes: ProfileChangeRow[] = []
  const pinRows: ProfilePinRow[] = []
  const entries = new Map((reply.pins ?? []).map((p) => [p.key, p] as const))
  const refusals = (reply.pins ?? []).filter(
    (p) => p.proposed?.status === 'not-an-output' || p.current?.status === 'not-an-output',
  )

  const base = {
    path: reply.path,
    profileName: reply.profileName,
    board: reply.board,
    warnings: reply.warnings ?? [],
    refusals,
  }

  if (!reply.ok || !reply.definition) {
    return {
      ...base,
      readable: false,
      error: reply.error ?? 'The bridge could not read this profile.',
      changes,
      pins: pinRows,
      changedCount: 0,
      translationOnlyCount: 0,
      definition: null,
      travel: null,
      controllerBoard: null,
      toolSetter: null,
      unsent: reply.unsent ?? [],
    }
  }

  const before = current?.controllerDefinition ?? null
  const after = reply.definition
  const controllerBoard = reply.controllerBoard === undefined
    ? current?.controllerBoard ?? null
    : reply.controllerBoard
  const toolSetter = reply.toolSetter === undefined
    ? toolSetterFromUccncDefinition(after)
    : reply.toolSetter

  const boardText = (board: MachineControllerBoard | null | undefined): string | null => {
    if (!board) return null
    return uccncBoardName(board.deviceType) ?? uccncBoardUnknownName(board.deviceType)
  }
  const boardBefore = boardText(current?.controllerBoard)
  const boardAfter = boardText(controllerBoard)
  pushChange(
    changes,
    'machine.controllerBoard',
    'Machine',
    'controller board',
    boardBefore ?? ABSENT,
    boardAfter ?? (boardBefore === null ? ABSENT : GONE),
  )

  // Travel first: it is the number a person recognises their own machine by,
  // and importing a profile whose soft limits are 0 would silently shrink it.
  // Shown, so that is a decision rather than a surprise.
  const travelBefore = current?.travel ?? null
  if (reply.travel) {
    for (const ax of ['x', 'y', 'z'] as const) {
      pushChange(
        changes, `travel.${ax}`, 'Machine', `${ax.toUpperCase()} travel`,
        travelBefore ? fmtNum(travelBefore[ax]) : ABSENT,
        fmtNum(reply.travel[ax]),
      )
    }
  }

  // FixedProbePos is only an import alias. Show the three app-owned machine
  // facts the import will replace, including absent and partial coordinates,
  // so Confirm cannot write a setter location the report never named.
  for (const axis of ['x', 'y', 'z'] as const) {
    const beforeValue = current?.probing?.toolSetter?.[axis]
    const afterValue = toolSetter?.[axis]
    pushChange(
      changes,
      `probing.toolSetter.${axis}`,
      'Probing',
      `tool setter ${axis.toUpperCase()} machine coordinate`,
      beforeValue === undefined ? ABSENT : fmtNum(beforeValue),
      afterValue === undefined
        ? beforeValue === undefined ? ABSENT : GONE
        : fmtNum(afterValue),
    )
  }

  const beforeAxes = new Map((before?.axes ?? []).map((a) => [a.axis, a]))
  const afterAxes = new Map(after.axes.map((a) => [a.axis, a]))

  for (const axis of PROFILE_AXES) {
    const b = beforeAxes.get(axis)
    const a = afterAxes.get(axis)
    if (!b && !a) continue
    const group = `${axis} axis`

    // An axis the record has and the profile does not is LOST on import, and
    // that is the loudest thing this report can say about a 4-axis machine
    // being handed a 3-axis profile. One row, named, not a silent absence -
    // and its PINS are still listed below, because "every pin the machine has"
    // does not stop at the axes the profile happens to carry.
    if (!a) {
      pushChange(changes, `axis.${axis}`, group, `${axis} axis`, 'in this machine', GONE)
    } else {
      for (const f of AXIS_FIELDS) {
        pushChange(
          changes, `axis.${axis}.${f.key}`, group, f.label,
          b ? f.read(b) : ABSENT, f.read(a),
        )
      }
    }

    for (const f of AXIS_PIN_FIELDS) {
      const key = `axis.${axis}.${f.key}`
      pinRows.push(pinRowFor(
        key, group, f.label,
        // NULL, NOT `ABSENT`/`GONE`: an axis one side does not have at all is
        // a side with no wire to compare, and `pinRowFor` prints those two
        // words itself. Passing the words here would let "not in this
        // machine" against "not in this profile" read as a wire that moved.
        b ? fmtPin(f.read(b)) : null,
        a ? fmtPin(f.read(a)) : null,
        entries.get(key),
      ))
    }

    if (a) {
      const bh = before?.homing.perAxis[axis]
      const ah = after.homing.perAxis[axis]
      for (const f of HOMING_FIELDS) {
        pushChange(
          changes, `homing.${axis}.${f.key}`, group, f.label,
          bh ? f.read(bh) : ABSENT,
          ah ? f.read(ah) : GONE,
        )
      }
    }
  }

  // The order is a SAFETY property (Z first retracts before anything moves in
  // plane), so it gets its own row rather than hiding inside an axis group.
  pushChange(
    changes, 'homing.order', 'Homing', 'homing order',
    before ? (before.homing.order.join(', ') || 'none') : ABSENT,
    after.homing.order.join(', ') || 'none',
  )

  for (const [key, label] of IO_PIN_FIELDS) {
    pinRows.push(pinRowFor(
      `io.${key}`, 'Inputs', label,
      before ? fmtPin(before.io[key]) : null,
      fmtPin(after.io[key]),
      entries.get(`io.${key}`),
    ))
  }

  // WO-1729: these are replacement fields just like axes and ordinary I/O.
  // Preview the neutral facts, not only the archived UCCNC aliases, so Confirm
  // cannot add/remove a live drive-alarm input or charge pump without saying so.
  const beforeFaults = before?.driveFaultInputs ?? []
  const afterFaults = after.driveFaultInputs ?? []
  const faultCount = Math.max(beforeFaults.length, afterFaults.length)
  for (let index = 0; index < faultCount; index++) {
    const key = `driveFaultInputs.${index}`
    pinRows.push(pinRowFor(
      key,
      'Drive safety',
      `drive-fault input ${index + 1}`,
      beforeFaults[index] === undefined ? null : fmtPin(beforeFaults[index]),
      afterFaults[index] === undefined ? null : fmtPin(afterFaults[index]),
      entries.get(key),
    ))
  }

  const beforePump = before?.chargePump
  const afterPump = after.chargePump
  if (beforePump !== undefined || afterPump !== undefined) {
    pushChange(
      changes,
      'chargePump.enabled',
      'Drive safety',
      'charge pump',
      beforePump === undefined ? ABSENT : beforePump.enabled ? 'on' : 'off',
      afterPump === undefined
        ? beforePump === undefined ? ABSENT : GONE
        : afterPump.enabled ? 'on' : 'off',
    )
  }
  if (beforePump?.pin !== undefined || afterPump?.pin !== undefined) {
    pinRows.push(pinRowFor(
      'chargePump.pin',
      'Drive safety',
      'charge-pump output',
      beforePump?.pin === undefined ? null : fmtPin(beforePump.pin),
      afterPump?.pin === undefined ? null : fmtPin(afterPump.pin),
      entries.get('chargePump.pin'),
    ))
  }
  if (beforePump?.frequencyHz !== undefined || afterPump?.frequencyHz !== undefined) {
    pushChange(
      changes,
      'chargePump.frequencyHz',
      'Drive safety',
      'charge-pump frequency (Hz)',
      beforePump?.frequencyHz === undefined ? ABSENT : fmtNum(beforePump.frequencyHz),
      afterPump?.frequencyHz === undefined
        ? beforePump?.frequencyHz === undefined ? ABSENT : GONE
        : fmtNum(afterPump.frequencyHz),
    )
  }

  // WO-1094: ControllerDefinition.settings is part of what Confirm replaces
  // and part of the exact object Apply caches. The preview was total only over
  // the older named fields, so a changed Compaccel, FaultSignals value or work
  // zero could be overwritten without any row naming it. Walk both containers
  // in profile order, then append current-only keys that the import removes.
  const settingId = (setting: ControllerSetting): string =>
    `${setting.controller}:${setting.key.toLowerCase()}`
  const settingsBefore = new Map((before?.settings ?? []).map((setting) => [
    settingId(setting), setting,
  ] as const))
  const settingsAfter = new Map((after.settings ?? []).map((setting) => [
    settingId(setting), setting,
  ] as const))
  const settingIds = [
    ...settingsAfter.keys(),
    ...[...settingsBefore.keys()].filter((id) => !settingsAfter.has(id)),
  ]
  for (const id of settingIds) {
    const b = settingsBefore.get(id)
    const a = settingsAfter.get(id)
    const setting = a ?? b!
    const sectionName = setting.key.split('.', 1)[0]
    pushChange(
      changes,
      setting.key,
      `${sectionName} settings`,
      setting.key,
      b ? formatUccncSettingValue(b.value) : ABSENT,
      a ? formatUccncSettingValue(a.value) : GONE,
    )
  }

  const vacuum = current?.coolantCapability?.vacuum
  if (vacuum && typeof vacuum === 'object') {
    const describe = (definition: ControllerDefinition | null | undefined): string => {
      const relay = vacuumRelayFromUccncDefinition(definition, vacuum.onCode)
      if (relay) return `${vacuum.onCode} -> port ${relay.port} pin ${relay.pin}`
      return vacuum.onCode === 'M7' || vacuum.onCode === 'M8'
        ? `${vacuum.onCode} -> no assigned relay in this profile`
        : `${vacuum.onCode} custom macro -> relay is defined by the macro`
    }
    pushChange(
      changes,
      'coolantCapability.vacuum',
      'Vacuum extraction',
      'vacuum output mapping',
      describe(before),
      describe(after),
    )
  }

  // A PIN THE BRIDGE KNOWS ABOUT AND THIS FILE DOES NOT IS STILL LISTED.
  // The field lists above are LienCAM's idea of what pins exist; the bridge
  // talks to the board. Where they disagree the bridge wins and the extra pin
  // is shown, because a pin missing from a preview is a pin nobody reviewed
  // and silently dropping one is the failure mode this contract names.
  const listed = new Set(pinRows.map((r) => r.key))
  for (const entry of reply.pins ?? []) {
    if (listed.has(entry.key)) continue
    listed.add(entry.key)
    pinRows.push(pinRowFor(
      entry.key, 'Other pins the bridge reported', entry.label || entry.key,
      null,
      entry.inProfile && entry.port !== null && entry.pin !== null
        ? fmtPin({ port: entry.port, pin: entry.pin, negate: entry.negate })
        : null,
      entry,
    ))
  }

  // THE VALUES THAT ARE SHOWN BUT NOT SENT. `unsentSettings` is the machine's
  // own value for every profile key this software cannot send yet (WO-947),
  // and confirming REPLACES that whole container. So it is a value the import
  // would change, and a value the import would change that the report does not
  // list is precisely the hazard this order exists to remove.
  //
  // ONE ROW PER KEY, NAMED IN THE CONTROLLER'S OWN WORDS, never a count:
  // `axessettingscontrolX.Compaccel` is a name a person can look up in UCCNC's
  // documentation, and "37 other settings changed" is not.
  const unsentBefore = new Map(
    (current?.unsentSettings ?? []).map((u) => [unsentSettingId(u), u] as const),
  )
  const unsentAfter = new Map(
    (reply.unsent ?? []).map((u) => [unsentSettingId(u), u] as const),
  )
  const unsentIds = [
    ...unsentAfter.keys(),
    ...[...unsentBefore.keys()].filter((id) => !unsentAfter.has(id)),
  ]
  for (const id of unsentIds) {
    const b = unsentBefore.get(id)
    const a = unsentAfter.get(id)
    pushChange(
      changes, `unsent.${id}`, 'Not sent to the controller',
      (a ?? b)!.key,
      b ? b.value : ABSENT,
      a ? a.value : GONE,
    )
  }

  // COUNTED OFF THE VERDICT, NEVER OFF THE STATE. `state === 'changed'` would
  // drop every profile-absent pin that importing would clear, remove or
  // overwrite, and the headline would then read "nothing would change" over a
  // table saying otherwise.
  const changedCount =
    changes.filter((r) => r.changed).length
    + pinRows.filter((r) => r.changed).length
  const replacementMarks = markProfileReplacements(current, reply, changes, pinRows)

  return {
    ...base,
    readable: true,
    error: null,
    changes,
    pins: pinRows,
    changedCount,
    translationOnlyCount: pinRows.filter((r) => r.translationOnly).length,
    ...replacementMarks,
    definition: after,
    travel: reply.travel,
    controllerBoard,
    toolSetter,
    unsent: reply.unsent ?? [],
  }
}

// ---------------------------------------------------------------------------
// PENDING IS NOT ACTIVE
// ---------------------------------------------------------------------------
//
// The bridge reads its profile ONCE, at startup. So a profile the config file
// names and a profile the bridge is RUNNING are two different facts, and a
// surface that prints one word for both is the defect class this whole order
// exists to remove - the software asserting a thing that has not happened.
//
// ACTIVE has exactly one source of truth: `hello.uccnc.profile`, the path the
// running bridge process actually opened. Nothing else may produce that word -
// not a config write that succeeded, not a reply with `ok: true`. Everything
// else is PENDING.

export type ProfileActivation = 'active' | 'pending' | 'none'

/**
 * Are these two the same profile file?
 *
 * Windows paths, so `\` and `/` are the same separator and case does not
 * distinguish two files. Never true for a null on either side: "we do not know
 * what the bridge is running" is not "it is running this".
 */
export function sameProfilePath(
  a: string | null | undefined, b: string | null | undefined,
): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const na = normalizeProfilePath(a)
  return na !== '' && na === normalizeProfilePath(b)
}

/** The comparison form behind `sameProfilePath`, exported because a reply has
 *  to be FILED under the profile it is about and a key must be one string.
 *  `''` for anything that is not a usable path - never a valid key. */
export function normalizeProfilePath(path: string | null | undefined): string {
  if (typeof path !== 'string') return ''
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** `Profiles/LienCNCV2.pro` -> `LienCNCV2.pro`. The name a person recognises;
 *  the full path stays on screen beside it, never replaced by this. */
export function profileFileName(path: string | null | undefined): string {
  if (typeof path !== 'string') return ''
  const parts = path.trim().replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path.trim()
}

/**
 * THE HEADLINE OVER THE TABLE, AND ZERO IS NOT THE SAME AS ALL-CLEAR.
 *
 * "This profile matches the machine as it is" is a CLAIM OF CONFIRMATION and
 * not a count. A count of zero can sit over a machine with a pin the board
 * REFUSES on both sides, a pin nobody can translate on either side, or a
 * dozen pins the profile never mentioned - and every one of those is a pin
 * this profile has confirmed NOTHING about. Printing the matched sentence
 * over them is the same defect as every other one this order has found: a
 * statement stronger than the evidence under it, on the one surface whose
 * whole job is to stop exactly that.
 *
 * SO THE MATCHED SENTENCE IS EARNED, NEVER DEFAULTED. It is printed only when
 * no row below contradicts it; otherwise the zero is still reported honestly
 * and then immediately qualified by what the zero does not cover.
 */
export function describeChangeHeadline(preview: ProfilePreview): string {
  const total = preview.changes.length + preview.pins.length
  const listed = 'Every value this profile would write is listed below, changed '
    + 'or not. Nothing is written until you confirm.'

  if (preview.changedCount > 0) {
    return `${preview.changedCount} of ${total} values would change. ${listed}`
  }

  // What a zero does NOT cover. Each of these is a pin about which this
  // profile has confirmed nothing, whatever the count says.
  const refused = preview.pins.filter((r) => r.state === 'refused').length
  const unchecked = preview.pins.filter((r) => r.state === 'untranslatable').length
  const unmentioned = preview.pins.filter((r) => r.state === 'not-in-profile').length

  const caveats: string[] = []
  if (refused > 0) {
    caveats.push(refused === 1
      ? '1 pin the board REFUSES - it does not work now and importing would '
        + 'not fix it'
      : `${refused} pins the board REFUSES - they do not work now and `
        + 'importing would not fix them')
  }
  if (unchecked > 0) {
    caveats.push(unchecked === 1
      ? '1 pin nobody can check on either side'
      : `${unchecked} pins nobody can check on either side`)
  }
  if (unmentioned > 0) {
    caveats.push(unmentioned === 1
      ? '1 pin this profile never mentions, so nothing in it confirmed that pin'
      : `${unmentioned} pins this profile never mentions, so nothing in it `
        + 'confirmed those pins')
  }

  if (caveats.length === 0) {
    return 'This profile matches the machine as it is. Nothing would change. '
      + 'Every value it would write is listed below anyway, so you can see what '
      + '"nothing" is made of.'
  }

  const list = caveats.length === 1
    ? caveats[0]
    : `${caveats.slice(0, -1).join('; ')}; and ${caveats[caveats.length - 1]}`
  return `Nothing would change. THAT IS NOT AN ALL-CLEAR: ${list}. ${listed}`
}

function replacementName(replacement: ProfileReplacement): string {
  const group = /^([A-Z]) axis$/.exec(replacement.group)?.[1] ?? replacement.group
  const label = replacement.label.replace(/\s*\([^)]*\)\s*$/, '')
  return `${group} ${label}`
}

/** The warning sits in the fixed preview header before Confirm, so a long
 * report cannot scroll it out of sight before the operator agrees. */
export function describeProfileReplacementSummary(preview: ProfilePreview): string | null {
  const replacements = preview.replacements ?? []
  const bridgeDiffers = preview.replacementSource === 'bridge'
    && preview.replacementSourcesDiffer === true
  if (replacements.length === 0) {
    return bridgeDiffers
      ? 'The bridge reports no values you set yourself will be replaced. Its list differs '
        + "from this app's provenance, so the bridge's list is shown."
      : null
  }
  const first = replacements[0]
  const noun = replacements.length === 1 ? 'value' : 'values'
  const source = bridgeDiffers
    ? " The bridge's list differs from this app's provenance, so the bridge's list is shown."
    : ''
  return `Re-importing ${profileFileName(preview.path)} will replace `
    + `${replacements.length} ${noun} you set yourself, including `
    + `${replacementName(first)} ${first.before} -> ${first.after}.${source}`
}

export function describeProfileReplacementTooltip(replacement: ProfileReplacement): string {
  return `${replacement.provenance.kind}: ${replacement.provenance.source}. `
    + `${replacementName(replacement)} ${replacement.before} will be replaced by `
    + `${replacement.after} when you confirm this re-import.`
}

export function describeProfileReplacementConsole(preview: ProfilePreview): string | null {
  const replacements = preview.replacements ?? []
  if (replacements.length === 0) return null
  const first = replacements[0]
  const noun = replacements.length === 1 ? 'value' : 'values'
  return `Re-imported ${profileFileName(preview.path)}: replaced ${replacements.length} `
    + `${noun} you set yourself; first key ${first.key}: `
    + `${first.before} -> ${first.after}.`
}

/**
 * The deliberately small vocabulary used by the full-height profile review.
 * The table is for scanning values, while the exact reason remains available
 * from the status tooltip. Keeping this decision beside the comparison model
 * prevents a second UI from inventing a different meaning for the same row.
 */
export type ProfilePreviewRowStatus = 'same' | 'changes' | 'new' | 'unreadable'

/** Short, in-view help for the status column. The detailed explanation for a
 * particular row is still its tooltip; this line only teaches the vocabulary. */
export const PROFILE_PREVIEW_STATUS_HELP =
  'Status: same keeps the current value; changes writes a different value; '
  + 'new adds a value the machine does not have; unreadable means the board '
  + 'or bridge cannot verify the result. Hover or focus a status for the exact reason.'

/** Classify one pin without weakening the safety state carried by the report.
 * An unreadable/refused result outranks a change mark because "changes" alone
 * would hide the more important fact that the resulting board value cannot be
 * verified. A genuinely absent current pin is called new only when both sides
 * are readable enough to make that claim. */
export function profilePinPreviewStatus(row: ProfilePinRow): ProfilePreviewRowStatus {
  if (row.state === 'refused' || row.state === 'untranslatable') return 'unreadable'
  if (row.rawBefore === ABSENT && row.rawAfter !== GONE) return 'new'
  if (row.changed) return 'changes'
  if (row.state === 'not-in-profile') return 'unreadable'
  return 'same'
}

/** Classify a non-pin value using the same four-word vocabulary. */
export function profileChangePreviewStatus(row: ProfileChangeRow): ProfilePreviewRowStatus {
  if (row.before === ABSENT && row.after !== GONE) return 'new'
  return row.changed ? 'changes' : 'same'
}

/** The status tooltip for a non-pin row. Pin rows already carry their exact
 * safety explanation as `outcome`; value rows previously had no equivalent. */
export function describeProfileChange(row: ProfileChangeRow): string {
  const name = `${row.group} - ${row.label}`
  const status = profileChangePreviewStatus(row)
  if (status === 'new') return `${name} is not in this machine and would become ${row.after}.`
  if (status === 'changes') return `${name} would change from ${row.before} to ${row.after}.`
  return `${name} would stay ${row.after}.`
}

/** The compact sentence kept in the Machine Library after the report moves
 * into its own view. It is intentionally only the count and never repeats the
 * long safety prose that belongs in the review itself. */
export function describeProfilePreviewSummary(preview: ProfilePreview): string {
  const total = preview.changes.length + preview.pins.length
  if (!preview.readable) return `${profileFileName(preview.path)} could not be read.`
  return `${preview.changedCount} of ${total} values would change`
}

/** `active` ONLY when the running bridge says it opened this exact file. */
export function profileActivation(args: {
  runningProfile: string | null | undefined
  chosenProfile: string | null | undefined
}): ProfileActivation {
  if (typeof args.chosenProfile !== 'string' || args.chosenProfile.trim() === '') return 'none'
  return sameProfilePath(args.runningProfile, args.chosenProfile) ? 'active' : 'pending'
}

/** The sentence beside the badge, in plain words. Always names the restart,
 *  because a bridge that has not been restarted is still driving the machine
 *  with its old profile no matter what any file now says. */
export function describeProfileActivation(args: {
  runningProfile: string | null | undefined
  chosenProfile: string | null | undefined
  bridgeCapability?: 'hosted' | 'supervisor' | 'unhosted'
}): string {
  const state = profileActivation(args)
  if (state === 'none') return ''
  if (state === 'active') {
    return 'Active. The bridge opened this profile when it started, so this is '
      + 'what the machine is running.'
  }
  const running = profileFileName(args.runningProfile)
  const recovery = args.bridgeCapability === 'unhosted'
    ? 'Close the bridge window and start it again to restart the bridge'
    : 'Use Reconnect on the Control screen to restart the bridge'
  return running === ''
    ? `Pending. The bridge has not said which profile it is running. ${recovery} `
      + 'before this profile drives the machine.'
    : `Pending. The bridge is still running ${running}. ${recovery} before `
      + 'this profile drives the machine.'
}

/**
 * WO-1002 attempt 4 - ONE CONFIG-WRITE REQUEST AND WHAT CAME BACK, filed under
 * the profile it is about.
 *
 * `path` is the profile the request was FOR, not the profile that happens to
 * be selected. Every reply is stored against it and every sentence below is
 * written from it, so a result can only ever be reported against its own
 * profile - by construction, not by the surface remembering to check.
 */
export interface ProfileRequestOutcome {
  path: string
  reply: BridgeSetProfileReply | null
  /** The call itself failed (threw, no bridge, no answer). Null when a reply
   *  came back at all, even a refusing one. */
  error: string | null
}

export type ProfileRequestState =
  /** Asked, nothing back yet. */
  | 'none'
  /** The call itself failed - no reply exists. */
  | 'failed'
  /** A reply came back about a DIFFERENT profile. It answers some other
   *  request, so it says nothing about this one either way. */
  | 'mismatched'
  /** The bridge wrote the config file. Still not active; still needs a restart. */
  | 'requested'
  /** The bridge answered and declined to write. */
  | 'refused'

/**
 * WO-1002 attempt 4 - A REPLY IS MATCHED TO THE REQUEST IT ANSWERS.
 *
 * `mismatched` is the state that did not exist before and is why this function
 * does: a `setBridgeProfile` reply whose `requestedProfile` is not the file we
 * asked about is not this request's result, and reporting it as one is how an
 * operator ends up told a profile is going live that is not.
 */
export function profileRequestState(outcome: ProfileRequestOutcome): ProfileRequestState {
  if (outcome.error !== null) return 'failed'
  const reply = outcome.reply
  if (reply === null) return 'none'
  if (!sameProfilePath(reply.requestedProfile, outcome.path)) return 'mismatched'
  if (!reply.ok || !reply.written) return 'refused'
  return 'requested'
}

/**
 * What the config-write REQUEST did - and it is a request, which is the whole
 * reason this sentence exists separately from the one above.
 *
 * A reply with `ok: true` means A FILE WAS WRITTEN. It does not mean a profile
 * is in use, and this sentence may never say or imply that it does: the bridge
 * goes on running what it opened at startup until somebody restarts it.
 *
 * EVERY SENTENCE NAMES `outcome.path` - the profile the request was for. It
 * cannot name the current selection because it is never given it.
 */
export function describeConfigWriteRequest(
  outcome: ProfileRequestOutcome,
  bridgeCapability: 'hosted' | 'supervisor' | 'unhosted' = 'hosted',
): string {
  const name = profileFileName(outcome.path)
  const state = profileRequestState(outcome)
  if (state === 'none') return ''
  if (state === 'failed') {
    return `The bridge was asked to use ${name} and could not: ${outcome.error}. `
      + 'Nothing on the machine PC was written and nothing on the machine has changed.'
  }
  const reply = outcome.reply!
  if (state === 'mismatched') {
    const answered = profileFileName(reply.requestedProfile)
    const about = answered === ''
      ? 'did not say which profile it was answering about'
      : `answered about ${answered} instead`
    return `The bridge was asked to record ${name} and ${about}, so this reply `
      + `is not an answer about ${name}. Whether ${name} was recorded is `
      + 'unknown - nothing here may be read as a result for it.'
  }
  if (state === 'refused') {
    return `The bridge refused to record ${name}: `
      + `${reply.error ?? 'it did not say why'}. Nothing on the machine PC was `
      + 'written and nothing on the machine has changed.'
  }
  const where = reply.configPath ?? 'its config file'
  const running = profileFileName(reply.runningProfile)
  const still = running === ''
    ? 'The bridge has not said which profile it is running.'
    : `The bridge is still running ${running}.`
  const recovery = bridgeCapability === 'unhosted'
    ? 'Close the bridge window and start it again to restart the bridge'
    : 'Use Reconnect on the Control screen to restart the bridge'
  return `Requested, not active. The bridge wrote ${name} into ${where}. `
    + `${still} ${recovery} before this profile drives the machine.`
}

// ---------------------------------------------------------------------------
// WO-1002 attempt 5 - A PREVIEW REPLY IS MATCHED TO THE PROFILE IT ANSWERS
// ---------------------------------------------------------------------------
//
// THE AUDITED DEFECT (MachineLibraryModal.tsx:630): the previous round matched
// only the CONFIG-WRITE reply. `BridgeProfilePreviewReply.path` has been part
// of the contract from the start, for exactly this reason, and nothing
// compared it. A preview reply about profile B was therefore displayed under
// profile A, its `definition` imported as A's values, and a config write then
// requested for A - so a person reads B's numbers, agrees to them, and A's
// record is overwritten with them.
//
// That is worse than the write-side defect it follows: there the false
// statement was on screen, here the WRONG VALUES REACH THE RECORD. It defeats
// the dry run's one guarantee - that the values shown and imported belong to
// the profile the person picked - on the surface built to provide it.
//
// The rule is the same rule, applied to the other call: identity decides, not
// what happens to be selected when a reply lands. A reply that does not carry
// the identity of what it answers (an empty `path`) is not an answer either -
// it fails loudly rather than being guessed at, the same way an empty
// `requestedProfile` does above.

/**
 * Does this preview reply answer the profile we asked about?
 *
 * Matching is by normalised Windows path, so slashes and case may differ - a
 * bridge echoing the same file back a different way is echoing the same file,
 * and refusing to recognise it would raise a false alarm on every reply.
 *
 * A missing reply, or one whose `path` is empty, is NOT a match. "The bridge
 * did not say which profile it read" is not "it read the one we asked for".
 */
export function previewAnswersProfile(
  requested: string,
  reply: Pick<BridgeProfilePreviewReply, 'path'> | null | undefined,
): boolean {
  if (reply === null || reply === undefined) return false
  return sameProfilePath(reply.path, requested)
}

/**
 * What a caller says when the bridge answered about another file.
 *
 * It names BOTH files, because "the bridge answered about something else" is
 * only actionable if a person can see what it answered about. And it states
 * that nothing was shown and nothing was changed, because the alternative
 * reading - that a report is on screen somewhere and may be trusted - is the
 * defect this sentence exists to announce.
 *
 * Said once, here, so the surface and the tests cannot drift into two
 * different claims.
 */
export function describeProfilePreviewMismatch(args: {
  requested: string
  answered: string | null | undefined
}): string {
  const name = profileFileName(args.requested)
  const answered = profileFileName(args.answered)
  const about = answered === ''
    ? 'did not say which profile it read'
    : `answered about ${answered} instead`
  return `The bridge was asked to preview ${name} and ${about}, so nothing in `
    + `that reply describes ${name}. No report was shown and nothing was `
    + `changed. Choose ${name} again for a report the bridge answers.`
}

// ============================================================================
// WO-1003 - A CANDIDATE VFD DEFINITION, DERIVED FROM THE PROFILE'S MODBUS
// TABLE (design slice S9)
// ============================================================================
//
// EVERYTHING THIS PRODUCES IS A GUESS AND IS LABELLED ONE. `verified` is the
// literal type `false` on the candidate and on every single field inside it,
// so no code path anywhere can hand this to a surface with a value flipped
// true. That is not ceremony: `verified` is what stands between a generated
// file and a 24,000 RPM spindle (vfdDefinition.ts, rule 1), and a wrong VFD
// register does not fail loudly - it spins a spindle at the wrong speed.
//
// WHAT THE PROFILE ACTUALLY KNOWS, AND WHAT IT CANNOT KNOW.
// The Modbus table describes HOW UCCNC TALKS TO THE DRIVE - the port, the
// framing, the timing, the slave address, and which register each exchange
// touches. It says nothing whatsoever about WHAT THE DRIVE DOES with what it
// is sent: the word that means "run clockwise", the RPM-to-word scale, how a
// status word decodes, what counts as a fault. Those live in the drive's
// manual and in a person's measurements (`registers.setpoint.scale` on Operator's
// inverter is `set.rpm / 2.4`, which he measured - huanyangGt.ts:60-64).
//
// So this deliberately produces something that IS NOT a `VfdDefinition` and
// cannot be cast into one. It carries the half the profile knows, and NAMES
// the half it does not in `missing`. A shape that satisfied `VfdDefinition`
// would have had to invent a command table, and an invented command table is
// a spindle command nobody chose.
//
// A REGISTER THE TABLE DOES NOT CONTAIN IS ABSENT, NEVER ZERO. Absent is a
// missing key on `registers`, not `{ address: 0, count: 0 }`. Register 0 is a
// real register on real drives; writing "we did not find it" as "write to
// register 0" is the exact class of silent wrong-register defect this slice
// was scheduled last to avoid.
//
// BOTH FILE SHAPES ARE READ, AND THE CONNECTION THE PROFILE USES IS THE ONE
// TAKEN (WO-1646). UCCNC has written its Modbus table two ways:
//
//   - `[ModbusMaster]` with CSV `Conn<c>` / `Conn<c>Fn<f>` lines - Operator's
//     earlier `Profiles/LienCNC.pro`, recorded at `huanyangGt.ts:5-11`:
//       Conn0="VFD & SPINDLE",True,25,1,297,RTU,COM3,19200,8,None,1,True,4
//     with the field order from UCCNC's own comment header
//     (`docs/research/uccnc-api-probe/Import.cs:66-72`);
//   - `[Modbus_connection_<c>]` + `[Modbus_function_<c>_<f>]` with named keys -
//     what UCCNC 1.2118 writes, and Operator's live profile
//     (`docs/machine/profiles/LienCNCV2.pro:2306-2355`).
//
// Until WO-1646 only `[ModbusMaster]` Conn0 was read, so Operator's own profile -
// and anyone's written by a current UCCNC - derived nothing, and a drive on
// Conn1 was never found. Operator ruling 2026-09-17: "This needs to be able to be used by
// anyone, and their machine and settings are apt to be different."
//
// WHICH CONNECTION. The one the profile switches on. When exactly one is on,
// that is the link UCCNC talks over and it is read. When several are on, the
// one whose exchanges carry a spindle speed is read, if exactly one does. When
// none is on, or several are and the file cannot tell them apart, nothing is
// derived and the refusal names the connections, because which device is on
// which link is then something only the machine's owner knows. A connection
// that is not read is named in the notes, never dropped silently.

// IT READS WITHOUT CONSUMING. Everything below reaches the parsed sections
// through `peek`, which does NOT record a read the way `rawOf` does. A key
// this function looks at is still an unheld machine fact as far as
// `collectSettings` is concerned, and still lands in `definition.settings`
// as the exact read-only Modbus record WO-954 pins. Deriving a guess from a
// key must not change what the importer carries for it.
//
// WHAT IS DELIBERATELY NOT READ: `[ModbusEZ]`. That section carries hex
// command words (`ONCW=0001`, `STOP=0005`) that happen to match Operator's drive,
// and it is UCCNC's SIMPLIFIED SPINDLE PAGE - a second, different control path
// whose values may be stale, may be for another drive, or may never have been
// used. Taking run/stop words from a page that might not be the one in use is
// precisely the guess that starts a spindle wrongly. The command table is left
// missing and named, and a person reads it off the drive.

/** One derived value: what it is, where in the profile it came from, and the
 *  fact that nobody has checked it against the drive.
 *
 *  `verified` is typed as the literal `false`, so an object claiming a checked
 *  field is not assignable here and cannot be constructed by mistake. */
export interface DerivedVfdField {
  /** Where it sits in the candidate: `link.port`, `registers.command.address`. */
  path: string
  value: string | number | boolean
  /** The profile key it was read from - `ModbusMaster.Conn0 field 6 (Comport)`. */
  from: string
  verified: false
}

/** Something a working definition needs that the Modbus table did not carry,
 *  with a whole sentence saying where a person gets it instead. Named, never
 *  counted: a gap reported as a number is a gap nobody can go and close. */
export interface DerivedVfdGap {
  path: string
  why: string
}

/** The link fields a Modbus table can state. Every one optional, because the
 *  candidate states only what the file said. Built from the real link types so
 *  it cannot drift from the format it is a partial view of. */
export type DerivedVfdLink =
  Partial<Omit<VfdSerialLink, 'transport'> & Omit<VfdTcpLink, 'transport'>>
  & { transport?: 'rtu' | 'tcp' }

/** Registers by role. A role the table did not name is a MISSING KEY. */
export type DerivedVfdRegisters = Partial<Record<VfdRegisterRole, VfdRegister>>

/**
 * A candidate VFD definition. Not a `VfdDefinition`, on purpose - see the
 * block comment above.
 */
export interface DerivedVfdCandidate {
  /** The connection's own name in the profile, e.g. `VFD & SPINDLE`. Null when
   *  the file did not name it - never a manufactured name. */
  name: string | null
  /** Which section of which shape this was read from, in words. */
  source: string
  /** Whether the PROFILE says this connection runs. Not a claim about the
   *  drive, and necessarily true: a connection the profile has switched off
   *  is never derived from. Kept because a surface showing a
   *  candidate should be able to say the file agreed it was live. */
  enabled: boolean
  /** Always false, and typed so it can only ever be false. */
  verified: false
  link: DerivedVfdLink
  protocol: Partial<VfdProtocol>
  registers: DerivedVfdRegisters
  /**
   * EVERY derived value, each marked unverified. This is the checklist a
   * person walks with the drive's manual open, one line per number to check.
   * It is not a second copy: `link`, `protocol` and `registers` are assembled
   * from these same entries at the one call site that reads each key.
   */
  unverified: readonly DerivedVfdField[]
  /** What a working definition still needs, named. */
  missing: readonly DerivedVfdGap[]
  /** Anything the table said that was not used, and why. Never silence. */
  notes: readonly string[]
  /** The sentence a surface must show beside this, unedited. */
  warning: string
}

/**
 * What the derivation hands back: at most one candidate, and when there is
 * none, the reason in words.
 *
 * `candidate` is null or a candidate, full stop - THE REFUSAL CARRIES NO
 * FIELDS. `refused` is a sentence for a person to read, not an empty
 * definition, not a default and not a placeholder; nothing downstream can
 * mistake it for something a spindle could be driven with. It exists because
 * "nothing came out" is useless on its own: a person who picked a profile
 * expecting a drive needs to know whether no table is declared, no connection
 * is switched on, or several are and the file cannot tell which is the drive,
 * because those are three different things to go and fix.
 */
export interface DerivedVfdResult {
  candidate: DerivedVfdCandidate | null
  /** Null exactly when `candidate` is not null. */
  refused: string | null
}

/** The sentence that goes with every candidate, said once so a surface and a
 *  test cannot drift into two different claims. */
export const DERIVED_VFD_WARNING =
  'Nothing here has been checked against the drive. Every value was read out '
  + "of the UCCNC profile's Modbus table, which says how UCCNC talks to the "
  + 'drive and never says what the drive does with what it is sent. This is a '
  + 'starting point, not a definition: check every line against the drive '
  + 'itself, and fill in what is missing from its manual, before the spindle '
  + 'is allowed to turn.'

// ---------------------------------------------------------------------------
// Reading the table - both shapes, into one record
// ---------------------------------------------------------------------------

/** A value the profile stated, and the key it stated it under. Null means the
 *  profile did not state it, or stated something unreadable - which are the
 *  same thing to everything downstream: absent. */
interface RawStated<T> {
  value: T
  from: string
}

type RawMaybe<T> = RawStated<T> | null

/**
 * Read a key WITHOUT recording it as read.
 *
 * `rawOf` exists to record what the importer consumed, which is what makes
 * WO-947's coverage an exact measurement. This function must not disturb that:
 * a Modbus key is still carried verbatim into `definition.settings` whether or
 * not a guess was derived from it.
 */
const peek = (s: Section | undefined, key: string): string | undefined =>
  s?.values.get(key.toLowerCase())?.value

const statedText = (from: string, raw: string | undefined): RawMaybe<string> => {
  const t = raw?.trim() ?? ''
  return t === '' ? null : { value: t, from }
}

const statedNum = (from: string, raw: string | undefined): RawMaybe<number> => {
  const t = raw?.trim() ?? ''
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? { value: n, from } : null
}

const statedBool = (from: string, raw: string | undefined): RawMaybe<boolean> => {
  const t = raw?.trim().toLowerCase() ?? ''
  if (t === 'true') return { value: true, from }
  if (t === 'false') return { value: false, from }
  return null
}

/** One Modbus exchange as the profile declares it. */
interface RawModbusRow {
  /** `ModbusMaster.Conn0Fn0`. */
  where: string
  name: RawMaybe<string>
  enabled: RawMaybe<boolean>
  type: RawMaybe<string>
  registerCount: RawMaybe<number>
  slaveAddress: RawMaybe<number>
  startRegister: RawMaybe<number>
}

/** One Modbus connection as the profile declares it. */
interface RawModbusConnection {
  /** `ModbusMaster.Conn0`. */
  where: string
  description: RawMaybe<string>
  enabled: RawMaybe<boolean>
  loopInterval: RawMaybe<number>
  retryCount: RawMaybe<number>
  timeout: RawMaybe<number>
  type: RawMaybe<string>
  baud: RawMaybe<number>
  comPort: RawMaybe<string>
  dataBits: RawMaybe<number>
  parity: RawMaybe<string>
  rs485Mode: RawMaybe<boolean>
  stopBits: RawMaybe<number>
  host: RawMaybe<string>
  tcpPort: RawMaybe<number>
  rows: RawModbusRow[]
}

/**
 * `[Modbus_connection_<c>]` + `[Modbus_function_<c>_<f>]` - the shape UCCNC
 * 1.2118 writes, with named keys (`docs/machine/profiles/LienCNCV2.pro`).
 * Each connection lists its exchanges as `Function_<f>=<section name>`.
 *
 * The TCP key names of this shape are not in any sample here, so a TCP
 * connection contributes no host or port and the candidate names both as
 * missing - nothing is guessed at a key the file has never been seen to carry.
 */
function readNamedConnections(sections: Map<string, Section>): RawModbusConnection[] {
  const numbered: { c: number; section: Section }[] = []
  for (const [name, section] of sections) {
    const m = /^modbus_connection_(\d+)$/.exec(name)
    if (m) numbered.push({ c: Number(m[1]), section })
  }
  numbered.sort((x, y) => x.c - y.c)
  return numbered.map(({ section: s }) => {
    const where = s.name
    const at = (key: string): [string, string | undefined] => [`${where}.${key}`, peek(s, key)]
    const rows: RawModbusRow[] = []
    for (let n = 0; ; n += 1) {
      const target = peek(s, `Function_${n}`)?.trim()
      if (target === undefined || target === '') break
      const fs = sections.get(target.toLowerCase())
      if (fs === undefined) continue
      const rowAt = (key: string): [string, string | undefined] => [`${fs.name}.${key}`, peek(fs, key)]
      rows.push({
        where: fs.name,
        name: statedText(...rowAt('Name')),
        enabled: statedBool(...rowAt('Enabled')),
        slaveAddress: statedNum(...rowAt('Slaveaddress')),
        type: statedText(...rowAt('Type')),
        registerCount: statedNum(...rowAt('Registercount')),
        startRegister: statedNum(...rowAt('Startregister')),
      })
    }
    const type = statedText(...at('Type'))
    const isTcp = (type?.value ?? '').toUpperCase() === 'TCP'
    return {
      where,
      description: statedText(...at('Description')),
      enabled: statedBool(...at('Enabled')),
      loopInterval: statedNum(...at('Loopinterval')),
      retryCount: statedNum(...at('Retrycount')),
      timeout: statedNum(...at('Timeout')),
      type,
      comPort: isTcp ? null : statedText(...at('Serial_Comport')),
      baud: isTcp ? null : statedNum(...at('Serial_Baudrate')),
      host: null,
      tcpPort: null,
      dataBits: statedNum(...at('Serial_Databits')),
      parity: statedText(...at('Serial_Parity')),
      stopBits: statedNum(...at('Serial_Stopbits')),
      rs485Mode: statedBool(...at('Serial_RS485mode')),
      rows,
    }
  })
}

/**
 * Split one `Conn` line on commas that are not inside quotes, and drop the
 * quotes - a straight port of UCCNC's own reader
 * (`docs/research/uccnc-api-probe/Import.cs:74-87`), because the connection
 * name may contain a comma and a naive split would shift every field after it.
 */
function splitConnLine(value: string): string[] {
  const out: string[] = []
  let quoted = false
  let cur = ''
  for (const ch of value) {
    if (ch === '"') { quoted = !quoted; continue }
    if (ch === ',' && !quoted) { out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  out.push(cur.trim())
  return out
}

/**
 * `[ModbusMaster]` with CSV `Conn` lines - the shape the design and the
 * `huanyangGt.ts` transcription describe.
 *
 * THE FIELD ORDER IS UCCNC'S OWN, NOT INFERRED FROM OPERATOR'S ONE SAMPLE. The
 * section carries a comment header giving it, quoted at
 * `docs/research/uccnc-api-probe/Import.cs:66-72`:
 *
 *   Conn<c>      = "Name",Enabled,Loopinterval,Retrycount,Timeout,Type,
 *                  Comport,Baud,Databits,Parity,Stopbits,RS485mode,FnCount
 *   Conn<c>Fn<f> = "Name",Enabled,Slaveaddress,Type,Registercount,
 *                  Startregister,UCCNCstartregister
 *
 * That closes half of design section 5's unknown 3: the ORDER is documented by
 * the file itself. What stays open is whether every UCCNC version writes the
 * same header - which is why a short line contributes fewer fields rather than
 * shifting the ones it has, and why nothing here is defaulted.
 *
 * Fields 6 and 7 are the one place the meaning depends on the transport:
 * host and network port for TCP, serial port and baud otherwise - which is
 * how UCCNC's own reader branches (`Import.cs:104-108`).
 */
function readMasterConnections(sections: Map<string, Section>): RawModbusConnection[] {
  const s = sections.get('modbusmaster')
  if (!s) return []
  const out: RawModbusConnection[] = []
  // Every `Conn<c>` line the section declares, in number order - a table
  // holding Conn1 and no Conn0 still has a Conn1.
  const numbers = [...s.values.values()]
    .map((entry) => /^Conn(\d+)$/i.exec(entry.key))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((x, y) => x - y)
  for (const c of numbers) {
    const raw = peek(s, `Conn${c}`)
    if (raw === undefined) continue
    const where = `ModbusMaster.Conn${c}`
    const f = splitConnLine(raw)
    const field = (index: number, name: string): [string, string | undefined] =>
      [`${where} field ${index} (${name})`, f[index]]
    const rows: RawModbusRow[] = []
    for (let n = 0; ; n += 1) {
      const rowRaw = peek(s, `Conn${c}Fn${n}`)
      if (rowRaw === undefined) break
      const at = `${where}Fn${n}`
      const g = splitConnLine(rowRaw)
      const rowField = (index: number, name: string): [string, string | undefined] =>
        [`${at} field ${index} (${name})`, g[index]]
      rows.push({
        where: at,
        name: statedText(...rowField(0, 'Name')),
        enabled: statedBool(...rowField(1, 'Enabled')),
        slaveAddress: statedNum(...rowField(2, 'Slaveaddress')),
        type: statedText(...rowField(3, 'Type')),
        registerCount: statedNum(...rowField(4, 'Registercount')),
        startRegister: statedNum(...rowField(5, 'Startregister')),
      })
    }
    const type = statedText(...field(5, 'Type'))
    const isTcp = (type?.value ?? '').toUpperCase() === 'TCP'
    out.push({
      where,
      description: statedText(...field(0, 'Name')),
      enabled: statedBool(...field(1, 'Enabled')),
      loopInterval: statedNum(...field(2, 'Loopinterval')),
      retryCount: statedNum(...field(3, 'Retrycount')),
      timeout: statedNum(...field(4, 'Timeout')),
      type,
      comPort: isTcp ? null : statedText(...field(6, 'Comport')),
      baud: isTcp ? null : statedNum(...field(7, 'Baud')),
      host: isTcp ? statedText(...field(6, 'Host')) : null,
      tcpPort: isTcp ? statedNum(...field(7, 'Port')) : null,
      dataBits: statedNum(...field(8, 'Databits')),
      parity: statedText(...field(9, 'Parity')),
      stopBits: statedNum(...field(10, 'Stopbits')),
      rs485Mode: statedBool(...field(11, 'RS485mode')),
      rows,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Turning a declared connection into a labelled guess
// ---------------------------------------------------------------------------

/**
 * WHICH EXCHANGE IS WHICH REGISTER - the one inference in this file, and the
 * one that is refused whenever it is not certain.
 *
 * UCCNC does not label an exchange with a role. It has a NAME a person typed
 * ("VFD Speed") and a Modbus function type that says whether it reads or
 * writes. Matching a name against words is a guess, so it is made in the
 * safest possible way:
 *
 *   - a row must match EXACTLY ONE role, or it is assigned to none;
 *   - a role must be claimed by EXACTLY ONE row, or it is left absent;
 *   - direction has to agree - a role that is written is never taken from a
 *     read exchange, and the other way round.
 *
 * Every refusal becomes a named gap and a note. Leaving `registers.setpoint`
 * absent costs a person one line of typing; picking the wrong row for it
 * commands a spindle to the wrong speed.
 */
const DERIVED_ROLE_WORDS: readonly {
  role: VfdRegisterRole
  direction: 'read' | 'write'
  words: RegExp
}[] = [
  { role: 'setpoint', direction: 'write', words: /\b(speed|rpm|freq|frequency|hz|hertz)\b/i },
  { role: 'command', direction: 'write', words: /\b(on|off|run|stop|start|command|cmd|control|reset)\b/i },
  // WO-1074: the WORDS stay - the UCCNC plugin really does label this
  // function "VFD Error", and that label is how we recognise it in someone's
  // profile. The ROLE it maps to is runState, because 0x1001 is the inverter's
  // operating-state word and not a fault code. Matching on the wrong name is
  // fine; STORING it under the wrong name is what WO-1056 caught.
  { role: 'runState', direction: 'read', words: /\b(error|fault|alarm|trip)\b/i },
  { role: 'status', direction: 'read', words: /\b(status|state|monitor|readback)\b/i },
]

/** UCCNC's exchange-type names -> the Modbus function code the format carries.
 *  A type the VFD format has no function code for maps to nothing: 0x02 and
 *  0x0F are real Modbus and are not in `VFD_READ_FUNCTIONS` /
 *  `VFD_WRITE_FUNCTIONS`, so they are absent rather than approximated. */
const DERIVED_READ_FUNCTION: Record<string, VfdReadFunction> = {
  read_coils: 0x01,
  read_holdingregisters: 0x03,
  read_inputregisters: 0x04,
}

const DERIVED_WRITE_FUNCTION: Record<string, VfdWriteFunction> = {
  write_singlecoil: 0x05,
  write_singleregister: 0x06,
  write_multipleregisters: 0x10,
}

const rowDirection = (row: RawModbusRow): 'read' | 'write' | null => {
  const type = row.type?.value.toLowerCase() ?? ''
  if (type.startsWith('read_')) return 'read'
  if (type.startsWith('write_')) return 'write'
  return null
}

const describeRow = (row: RawModbusRow): string =>
  row.name === null ? row.where : `${row.where} ("${row.name.value}")`

const wholeWithin = (value: number | undefined, min: number, max: number): number | null =>
  value !== undefined && Number.isInteger(value) && value >= min && value <= max ? value : null

/**
 * Record one derived value in BOTH places at once - the assembled shape a
 * caller reads, and the unverified checklist a person walks. One call site per
 * fact, so the two cannot disagree about what was derived.
 *
 * Returns whether anything landed, so the caller can name the gap when the
 * profile stated nothing, or stated something this format cannot express.
 */
function takeDerived<T, V extends string | number | boolean>(
  fields: DerivedVfdField[],
  stated: RawMaybe<T>,
  path: string,
  translate: (value: T) => V | null,
  assign: (value: V) => void,
): boolean {
  if (stated === null) return false
  const value = translate(stated.value)
  if (value === null) return false
  assign(value)
  fields.push({ path, value, from: stated.from, verified: false })
  return true
}

const describeConnection = (c: RawModbusConnection): string =>
  c.description === null ? c.where : `${c.where} ("${c.description.value}")`

/** Does this connection carry a switched-on exchange that writes the spindle
 *  speed? The same role words the register matcher uses, so the two cannot
 *  disagree about what a speed exchange is. */
const carriesSpindleSpeed = (c: RawModbusConnection): boolean => {
  const speed = DERIVED_ROLE_WORDS.find((entry) => entry.role === 'setpoint')!
  return c.rows.some((row) => row.enabled?.value !== false
    && rowDirection(row) === 'write'
    && speed.words.test(row.name?.value ?? ''))
}

/**
 * WHICH CONNECTION THE PROFILE USES (WO-1646).
 *
 *  - exactly one switched on: that one - it is the link UCCNC talks over;
 *  - several switched on: the one carrying the spindle speed, if exactly one
 *    does;
 *  - otherwise a refusal naming the connections. The enabled field has to SAY
 *    it is on; an unreadable one is not on.
 */
function chooseUsedConnection(
  connections: RawModbusConnection[],
): { chosen: RawModbusConnection } | { refused: string } {
  const on = connections.filter((c) => c.enabled?.value === true)
  if (on.length === 1) return { chosen: on[0] }
  if (on.length === 0) {
    return {
      refused: `None of the Modbus connections this profile declares (${
        connections.map(describeConnection).join(', ')
      }) is switched on, so UCCNC is not talking to a drive over any of them and `
        + 'nothing was derived. Switch the drive\'s connection on in UCCNC and '
        + 'import the profile again, or set the drive up by hand from its manual.',
    }
  }
  const spindle = on.filter(carriesSpindleSpeed)
  if (spindle.length === 1) return { chosen: spindle[0] }
  return {
    refused: `This profile switches on ${on.length} Modbus connections (${
      on.map(describeConnection).join(', ')
    }) and ${spindle.length === 0 ? 'none' : `${spindle.length}`} of them `
      + `${spindle.length === 1 ? 'carries' : 'carry'} a spindle speed exchange, `
      + 'so which one is the drive cannot be told from the file and nothing was '
      + 'derived. Set the drive up by hand from its manual.',
  }
}

/**
 * Derive a candidate VFD definition from a UCCNC profile's Modbus table.
 *
 * PRODUCES NO CANDIDATE WHEN THE PROFILE DECLARES NO MODBUS CONNECTION - not
 * an empty candidate, not a default, not a placeholder. `[ModbusEZ]` is UCCNC's
 * simplified spindle page and is not a connection table, so it is never one.
 *
 * Both connection-table shapes are read (`[ModbusMaster]` and
 * `[Modbus_connection_N]`), and the connection taken is the one the profile
 * uses - see `chooseUsedConnection`. Every other connection is named in the
 * notes as not read.
 */
export function deriveVfdFromProfile(text: string): DerivedVfdResult {
  const sections = parseIni(text)
  const connections = [...readMasterConnections(sections), ...readNamedConnections(sections)]
  if (connections.length === 0) {
    return {
      candidate: null,
      refused: 'This profile declares no Modbus connection ([ModbusMaster] or '
        + '[Modbus_connection_N]), so there is no Modbus connection table to '
        + 'read a drive out of and nothing was derived. Set the drive up by '
        + 'hand from its manual.',
    }
  }

  const choice = chooseUsedConnection(connections)
  if ('refused' in choice) return { candidate: null, refused: choice.refused }
  const chosen = choice.chosen

  const fields: DerivedVfdField[] = []
  const missing: DerivedVfdGap[] = []
  const notes: string[] = []
  const gap = (path: string, why: string): void => { missing.push({ path, why }) }

  // Every other connection in the table is NAMED AND NOT READ, with the reason.
  for (const other of connections) {
    if (other === chosen) continue
    notes.push(
      `The profile also declares ${describeConnection(other)}, which was not read: `
      + (other.enabled?.value === true
        ? `it does not carry the spindle speed, and ${chosen.where} does.`
        : 'it is not switched on.'),
    )
  }

  const link: DerivedVfdLink = {}
  const protocol: Partial<VfdProtocol> = {}
  const registers: DerivedVfdRegisters = {}

  // --- the link ------------------------------------------------------------
  const gotTransport = takeDerived(fields, chosen.type, 'link.transport', (v) => {
    const t = v.toUpperCase()
    if (t === 'RTU') return 'rtu' as const
    if (t === 'TCP') return 'tcp' as const
    return null
  }, (v) => { link.transport = v })
  if (!gotTransport) {
    gap('link.transport', chosen.type === null
      ? 'the profile does not say whether this connection is a serial or a network link.'
      : `the profile calls this connection \`${chosen.type.value}\`, which is `
        + 'neither the serial (RTU) nor the network (TCP) link this software speaks.')
  }

  if (!takeDerived(fields, chosen.comPort, 'link.port', (v) => v, (v) => { link.port = v })
    && link.transport !== 'tcp') {
    gap('link.port', 'the profile does not name the serial port the drive is on.')
  }
  if (!takeDerived(fields, chosen.baud, 'link.baud', (v) => wholeWithin(v, 1200, 921600),
    (v) => { link.baud = v }) && link.transport !== 'tcp') {
    gap('link.baud', 'the profile does not state a serial speed this software can use.')
  }
  if (!takeDerived(fields, chosen.dataBits, 'link.dataBits',
    (v) => (v === 7 || v === 8 ? v : null), (v) => { link.dataBits = v })
    && link.transport !== 'tcp') {
    gap('link.dataBits', 'the profile does not state 7 or 8 data bits.')
  }
  if (!takeDerived(fields, chosen.parity, 'link.parity', (v) => {
    const p = v.toLowerCase()
    if (p === 'none' || p === 'odd' || p === 'even') return p as VfdParity
    return null
  }, (v) => { link.parity = v }) && link.transport !== 'tcp') {
    gap('link.parity', chosen.parity === null
      ? 'the profile does not state the parity of the link.'
      : `the profile sets parity to \`${chosen.parity.value}\`, which this `
        + 'software does not speak; it reads none, odd and even.')
  }
  if (!takeDerived(fields, chosen.stopBits, 'link.stopBits',
    (v) => (v === 1 || v === 2 ? v : null), (v) => { link.stopBits = v })
    && link.transport !== 'tcp') {
    gap('link.stopBits', 'the profile does not state 1 or 2 stop bits.')
  }
  // `RS485mode=True` is UCCNC driving the port half duplex, which is two-wire
  // RS485. FALSE IS NOT `none`: it could be four-wire RS485 or plain RS232 and
  // the file does not distinguish them, so nothing is derived and a person
  // looks at the drive's terminals.
  if (!takeDerived(fields, chosen.rs485Mode, 'link.rs485',
    (v) => (v ? ('two-wire' as const) : null), (v) => { link.rs485 = v })
    && link.transport !== 'tcp') {
    gap('link.rs485', 'the profile does not say the port is driven half duplex, '
      + 'which leaves four-wire RS485 and plain RS232 indistinguishable here; '
      + "read the wiring off the drive's terminals.")
  }
  if (!takeDerived(fields, chosen.host, 'link.host', (v) => v, (v) => { link.host = v })
    && link.transport === 'tcp') {
    gap('link.host', 'the profile does not name the address of the drive.')
  }
  if (!takeDerived(fields, chosen.tcpPort, 'link.tcpPort', (v) => wholeWithin(v, 1, 65535),
    (v) => { link.tcpPort = v }) && link.transport === 'tcp') {
    gap('link.tcpPort', 'the profile does not state a network port for the drive.')
  }

  if (!takeDerived(fields, chosen.loopInterval, 'link.pollIntervalMs',
    (v) => (Number.isFinite(v) && v >= 1 && v <= 5000 ? v : null),
    (v) => { link.pollIntervalMs = v })) {
    gap('link.pollIntervalMs', 'the profile does not state how often the drive is polled.')
  }
  if (!takeDerived(fields, chosen.retryCount, 'link.retryCount',
    (v) => wholeWithin(v, 0, 10), (v) => { link.retryCount = v })) {
    gap('link.retryCount', 'the profile does not state how many times a failed exchange is retried.')
  }
  if (!takeDerived(fields, chosen.timeout, 'link.timeoutMs',
    (v) => (Number.isFinite(v) && v >= 1 && v <= 10000 ? v : null),
    (v) => { link.timeoutMs = v })) {
    gap('link.timeoutMs', 'the profile does not state how long a reply is waited for.')
  }

  // --- which exchange is which register ------------------------------------
  const claims = new Map<VfdRegisterRole, RawModbusRow[]>()
  for (const row of chosen.rows) {
    if (row.enabled?.value === false) {
      notes.push(`${describeRow(row)} is switched off in the profile, so nothing `
        + 'was derived from it.')
      continue
    }
    const direction = rowDirection(row)
    if (direction === null) {
      notes.push(`${describeRow(row)} does not say whether it reads or writes, so `
        + 'it was not matched to anything.')
      continue
    }
    const name = row.name?.value ?? ''
    const matched = DERIVED_ROLE_WORDS
      .filter((entry) => entry.direction === direction && entry.words.test(name))
      .map((entry) => entry.role)
    if (matched.length === 0) {
      notes.push(`${describeRow(row)} was not matched to anything this software `
        + 'sends a drive; if it is one of them, say so by hand.')
      continue
    }
    if (matched.length > 1) {
      notes.push(`${describeRow(row)} reads as more than one thing `
        + `(${matched.join(', ')}), so it was not matched to any of them.`)
      continue
    }
    const role = matched[0]
    claims.set(role, [...(claims.get(role) ?? []), row])
  }

  const assigned: { role: VfdRegisterRole; row: RawModbusRow }[] = []
  for (const role of VFD_REGISTER_ROLES) {
    const rows = claims.get(role) ?? []
    if (rows.length === 0) {
      gap(`registers.${role}`, `no exchange in this table reads as the ${role} `
        + "register, so it is absent; find it in the drive's manual.")
      continue
    }
    if (rows.length > 1) {
      gap(`registers.${role}`, `${rows.length} exchanges `
        + `(${rows.map(describeRow).join(', ')}) read as the ${role} register, `
        + 'so none was picked; say which one by hand.')
      continue
    }
    const row = rows[0]
    const address = wholeWithin(row.startRegister?.value, 0, 65535)
    const count = wholeWithin(row.registerCount?.value, 1, 125)
    // BOTH OR NEITHER. Half a register is a write to an address with a length
    // this software chose, which is the silent wrong-register defect.
    if (address === null || count === null) {
      gap(`registers.${role}`, `${describeRow(row)} reads as the ${role} register `
        + 'and does not state a usable register address and length, so it is '
        + 'absent rather than partly guessed.')
      continue
    }
    registers[role] = { address, count }
    fields.push({
      path: `registers.${role}.address`, value: address,
      from: row.startRegister!.from, verified: false,
    })
    fields.push({
      path: `registers.${role}.count`, value: count,
      from: row.registerCount!.from, verified: false,
    })
    assigned.push({ role, row })
  }

  // --- what the assigned exchanges say about the protocol ------------------
  const oneOf = <V,>(
    values: { value: V; from: string }[],
  ): { value: V; from: string } | null => {
    if (values.length === 0) return null
    const first = values[0]
    return values.every((entry) => entry.value === first.value) ? first : null
  }

  const readCodes = assigned
    .filter((a) => rowDirection(a.row) === 'read')
    .map((a) => ({
      value: DERIVED_READ_FUNCTION[a.row.type?.value.toLowerCase() ?? ''],
      from: a.row.type?.from ?? a.row.where,
    }))
    .filter((entry) => entry.value !== undefined)
  if (!takeDerived(fields, oneOf(readCodes), 'protocol.readFunction', (v) => v,
    (v) => { protocol.readFunction = v })) {
    gap('protocol.readFunction', 'the table\'s read exchanges do not agree on one '
      + 'Modbus read function this software speaks, so none was taken.')
  }

  const writeCodes = assigned
    .filter((a) => rowDirection(a.row) === 'write')
    .map((a) => ({
      value: DERIVED_WRITE_FUNCTION[a.row.type?.value.toLowerCase() ?? ''],
      from: a.row.type?.from ?? a.row.where,
    }))
    .filter((entry) => entry.value !== undefined)
  if (!takeDerived(fields, oneOf(writeCodes), 'protocol.writeFunction', (v) => v,
    (v) => { protocol.writeFunction = v })) {
    gap('protocol.writeFunction', 'the table\'s write exchanges do not agree on one '
      + 'Modbus write function this software speaks, so none was taken.')
  }

  const slaves = assigned
    .map((a) => a.row.slaveAddress)
    .filter((s): s is RawStated<number> => s !== null)
  if (!takeDerived(fields, oneOf(slaves), 'link.slaveAddress',
    (v) => wholeWithin(v, 1, 247), (v) => { link.slaveAddress = v })) {
    gap('link.slaveAddress', 'the exchanges this software matched do not agree on '
      + 'one Modbus address for the drive, so none was taken.')
  }

  // --- everything the table structurally cannot know -----------------------
  gap('protocol.wordOrder', 'a Modbus table never says which half of a 32-bit '
    + "value comes first; take it from the drive's manual.")
  gap('registers.runState.values', 'the table says where the operating-state '
    + 'word is read and never what its values mean. Copy those meanings from '
    + "the drive's manual or record them during commissioning; they cannot be "
    + 'guessed from the register address or drive name.')
  gap('registers.setpoint.scale', 'the table says which register the speed is '
    + 'written to and never what the number in it means. The RPM-to-word scale '
    + "comes from the drive's manual, or from a measured RPM table - the operator's own "
    + 'inverter is `set.rpm / 2.4`, which the operator measured.')
  gap('registers.setpoint.encode', 'nothing in the table says how a computed '
    + 'speed is rounded, or the smallest and largest words the drive will accept.')
  gap('commands', 'the table does not carry the words that run, stop or reset '
    + "the drive. Read them from the drive's manual. (UCCNC's simplified "
    + 'spindle page holds values for a different control path and is '
    + 'deliberately not read here.)')
  gap('resetSequence', 'nothing says what clearing a fault takes on this drive, '
    + 'or how long it needs afterwards.')
  gap('status', 'the table says how many words the status block is and never '
    + 'what any of them mean, so no word is decoded.')
  gap('fault', 'nothing says what value in the fault register counts as a fault.')
  gap('upToSpeedToleranceRpm', 'nothing says how close to the commanded speed '
    + 'this drive settles.')
  if (chosen.description === null) {
    gap('name', 'the profile does not name this connection, so this candidate '
      + 'has no name yet.')
  }

  return {
    candidate: {
      name: chosen.description?.value ?? null,
      source: `${chosen.where} of the UCCNC profile`,
      enabled: true,
      verified: false,
      link,
      protocol,
      registers,
      unverified: fields,
      missing,
      notes,
      warning: DERIVED_VFD_WARNING,
    },
    refused: null,
  }
}

/**
 * The whole thing a surface says when it shows a derived candidate.
 *
 * Said here, once, so the modal and the tests cannot drift into two different
 * claims - the same reason `describeConfigWriteRequest` exists above. It leads
 * with the warning, because the first thing a person reads about a guess must
 * be that it is one, and it never renders a count on its own: what is missing
 * is listed by name, because a gap reported as "8 items" is a gap nobody can
 * go and close.
 */
export function describeDerivedVfd(candidate: DerivedVfdCandidate): string {
  const name = candidate.name === null ? 'this drive' : `"${candidate.name}"`
  const lines = [
    `${DERIVED_VFD_WARNING}`,
    '',
    `Read from ${candidate.source}, for ${name}.`,
    '',
    `To check against the drive (${candidate.unverified.length}):`,
    ...candidate.unverified.map((field) => `  ${field.path} = ${String(field.value)}  (${field.from})`),
  ]
  if (candidate.missing.length > 0) {
    lines.push('', 'Still needed before this can drive a spindle:')
    for (const gap of candidate.missing) lines.push(`  ${gap.path} - ${gap.why}`)
  }
  if (candidate.notes.length > 0) {
    lines.push('', 'Also worth knowing:')
    for (const note of candidate.notes) lines.push(`  ${note}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// WO-1670 - PARKS FROM THE PROFILE'S MACRO FOLDER (a convenience, never a need)
// ---------------------------------------------------------------------------
//
// UCCNC keeps a park as a macro file beside the profile
// (`Profiles/Macro_<profile>/M200.txt`), not in the `.pro`. A macro whose
// motion is exactly `G00 G53 Z<z>` and `G00 G53 X<x> Y<y>` - typed as G-code,
// or built by `exec.Code("G00 G53 Z" + parkZ)` from numbers the file declares
// - is that park, bound to its own M-code. Anything else is not a park and is
// left alone; nothing here refuses and nothing is guessed.

export interface UccncMacroFile {
  /** The file's name, e.g. `M200.txt` (a folder prefix is fine). */
  name: string
  text: string
}

/** The M-code stated by a UCCNC macro filename. A folder prefix is allowed
 *  because directory pickers preserve it; the profile's binding is still the
 *  basename, exactly as UCCNC reads it. */
function uccncMacroCode(file: UccncMacroFile): number | null {
  const base = file.name.split(/[\\/]/).pop() ?? file.name
  const match = /^M(\d+)\.txt$/i.exec(base)
  if (!match) return null
  const code = Number(match[1])
  return Number.isSafeInteger(code) ? code : null
}

/** A profile macro on the machine's one macro model. The text is deliberately
 *  not trimmed, parsed, translated, or replaced: it is the user's UCCNC body.
 *  The macro runtime will report any UCCNC C# it cannot execute when the user
 *  runs it, rather than silently substituting a LienCAM action. */
export function macroFromUccncFile(file: UccncMacroFile): MachineMacro | null {
  const mCode = uccncMacroCode(file)
  if (mCode === null) return null
  return {
    id: `uccnc-macro-m${mCode}`,
    name: `UCCNC M${mCode}`,
    mCode,
    body: file.text,
  }
}

/** Every M-code macro in a profile folder, in the same numeric order used by
 *  the macro editor. */
export function macrosFromUccncFiles(files: readonly UccncMacroFile[]): MachineMacro[] {
  return files
    .map(macroFromUccncFile)
    .filter((macro): macro is MachineMacro => macro !== null)
    .sort((a, b) => (a.mCode ?? 0) - (b.mCode ?? 0))
}

const G53_Z_LINE = /^G0?0\s*G53\s*Z\s*(-?\d+(?:\.\d+)?)$/i
const G53_XY_LINE = /^G0?0\s*G53\s*X\s*(-?\d+(?:\.\d+)?)\s*Y\s*(-?\d+(?:\.\d+)?)$/i

/** The G-code lines a macro file sends, in order: its `exec.Code(...)` calls
 *  whose every part is a literal or a number the file declares, else (a plain
 *  G-code macro) its non-comment lines. A call built from anything else
 *  (the operator's modal mode, say) is not a line this reader can state. */
function uccncMacroLines(text: string): string[] {
  const source = text.replace(/\r\n?/g, '\n')
  const numbers = new Map<string, string>()
  for (const m of source.matchAll(/\b(?:double|float|int|var|decimal)\s+([A-Za-z_]\w*)\s*=\s*(-?\d+(?:\.\d+)?)\s*;/g)) {
    numbers.set(m[1], m[2])
  }
  const calls = [...source.matchAll(/exec\.Code\s*\(([^;]*?)\)\s*;/g)]
  if (calls.length > 0) {
    const lines: string[] = []
    // A macro that goes on to DO something once there (prompt the operator,
    // switch an output - M2001's clamp stop) is more than a park, so what
    // follows the last move may only wait or put the modal mode back.
    const lastMove = calls.filter((call) => /G53/i.test(call[1])).pop()
    if (lastMove !== undefined) {
      const after = source.slice(lastMove.index! + lastMove[0].length)
        .replace(/\/\/.*$/gm, '')
        .replace(/while\s*\(\s*exec\.IsMoving\s*\(\s*\)\s*\)\s*\{\s*\}/g, '')
        .replace(/exec\.Code\s*\(\s*"G"\s*\+\s*\w+\s*\)\s*;/g, '')
      if (after.trim() !== '') return []
    }
    for (const call of calls) {
      let line = ''
      let stated = true
      for (const raw of call[1].split('+')) {
        const part = raw.trim()
        const literal = /^"([^"]*)"$/.exec(part)
        if (literal) line += literal[1]
        else if (numbers.has(part)) line += numbers.get(part)
        else if (/^-?\d+(?:\.\d+)?$/.test(part)) line += part
        else { stated = false; break }
      }
      if (stated) lines.push(line.trim().replace(/\s+/g, ' '))
    }
    return lines
  }
  return source.split('\n')
    .map((line) => line.replace(/\([^)]*\)/g, '').replace(/(;|\/\/).*$/, '').trim().replace(/\s+/g, ' '))
    .filter((line) => line !== '')
}

/** A park one UCCNC macro file states - the intermediate shape this file
 *  converts into a position macro (WO-1681: `positionMacroBody`). */
export interface UccncMacroPark {
  label: string
  x: number
  y: number
  z: number
  zFirst: boolean
  mCode: number
}

/** The park one macro file states, or null when it states none. */
export function parkFromUccncMacro(file: UccncMacroFile): UccncMacroPark | null {
  const mCode = uccncMacroCode(file)
  if (mCode === null) return null
  const motion = uccncMacroLines(file.text).filter((line) => /\bG53\b/i.test(line) || /^G0?[0-3]\b/i.test(line))
  if (motion.length !== 2) return null
  const zAt = motion.findIndex((line) => G53_Z_LINE.test(line))
  const xyAt = motion.findIndex((line) => G53_XY_LINE.test(line))
  if (zAt === -1 || xyAt === -1) return null
  const z = Number(G53_Z_LINE.exec(motion[zAt])![1])
  const xy = G53_XY_LINE.exec(motion[xyAt])!
  const comment = /^\s*\/\/\s*(?:Go to\s+)?(.+?)(?:\s+macro)?\s*$/im.exec(file.text.replace(/\r/g, ''))
  const label = comment && comment[1].length <= 24 ? comment[1] : `M${mCode}`
  return {
    label,
    x: Number(xy[1]),
    y: Number(xy[2]),
    z,
    zFirst: zAt < xyAt,
    mCode,
  }
}

/** Every park the macro files state, in M-code order. */
export function parksFromUccncMacros(files: readonly UccncMacroFile[]): UccncMacroPark[] {
  return files
    .map(parkFromUccncMacro)
    .filter((park): park is UccncMacroPark => park !== null)
    .sort((a, b) => (a.mCode ?? 0) - (b.mCode ?? 0))
}

/** The first four recognized parks as the machine's stored G30 points. This
 *  does not translate or replace a macro body and creates no M-code binding;
 *  it retains only the coordinates the strict recognizer proved. */
export function referencePositionsFromUccncParks(
  parks: readonly UccncMacroPark[],
): MachineReferencePositions | undefined {
  if (parks.length === 0) return undefined
  const positions: MachineReferencePositions = {}
  const pointNumbers = [1, 2, 3, 4] as const
  parks.slice(0, pointNumbers.length).forEach((park, index) => {
    positions[pointNumbers[index]] = { x: park.x, y: park.y, z: park.z }
  })
  return positions
}

/** The one console row an import says about parks. */
export function describeImportedParks(parks: readonly UccncMacroPark[], macroFiles: number): string {
  if (parks.length === 0) {
    return macroFiles === 0
      ? 'Parks: no macro files came with the profile, so no parks were imported - make a "go to machine position" macro on the Macros panel instead.'
      : `Parks: none of the ${macroFiles} macro file${macroFiles === 1 ? '' : 's'} is a park move (G53 Z then G53 X Y), so no parks were imported.`
  }
  const list = parks.map((park) => `M${park.mCode} "${park.label}" X${park.x} Y${park.y} Z${park.z}`).join('; ')
  return `Parks: ${parks.length} imported from the profile's macros - ${list} (machine coordinates).`
}

/** The one console row an import says about the profile's own macros. */
export function describeImportedMacros(macros: readonly MachineMacro[], macroFiles: number): string {
  if (macros.length === 0) {
    return macroFiles === 0
      ? 'Macros: no macro files came with the profile, so no macros were imported.'
      : `Macros: none of the ${macroFiles} selected file${macroFiles === 1 ? '' : 's'} had a UCCNC M-code filename.`
  }
  const list = macros.map((macro) => `M${macro.mCode}`).join(', ')
  return `Macros: ${macros.length} imported from the profile's macro folder - ${list}. Their UCCNC text is kept unchanged.`
}
