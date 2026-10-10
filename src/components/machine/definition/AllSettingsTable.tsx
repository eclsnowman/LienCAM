import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SettingBox } from './DefinitionFields'
import {
  grblFlag,
  grblMaskBit,
  recordGrblSettings,
  type GrblSettingsRecord,
} from '../../../lib/machine/grbl/settings'
import { controllerSurface } from '../../../lib/machine/controllerSurface'
import {
  uccncBoardDeviceTypeByName,
  uccncBoardName,
  uccncBoardOptions,
  uccncBoardUnknownName,
  withUccncBoardDeviceType,
} from '../../../lib/machine/controllerBoard'
import { buildSettingsIndex } from '../../../lib/machine/settingsIndex'
import { withOperatorStopParkAxis } from '../../../lib/machine/macros/clampPauseMacro'
import {
  UCCNC_SETTING_FIELDS,
  parseUccncSettingValue,
  uccncProfileOnlySettings,
} from '../../../lib/machine/uccncProfileImport'
import { exportUccncProfile } from '../../../lib/machine/uccncProfileExport'
import {
  definitionStatesKey,
  LIENCAM_SAFE_Z_KEY,
  normalizeMachineMCode,
  machineReferencePositions,
  machineSafeZ,
  parsePositionMacroBody,
  positionMacroBody,
  withCoolantCapability,
  withEnabledCoolantCapability,
  withMachineSafeZ,
  withVacuumCapability,
  type AxisDefinition,
  type AxisName,
  type ControllerSettingField,
  type CoolantChannel,
  type MachineConfig,
  type MachineMCode,
  type MachineProbeDefaults,
  type MachineReferencePositionNumber,
  type PinRef,
  UCCNC_SAFE_Z_KEY,
} from '../../../types'
import { useMachineControl } from '../../../store/machineControlStore'
import { writeGrblSettingAndReadBack } from '../../../lib/machine/machineSession'
import { PROBING_FEED_FIELDS, PROBING_GEOMETRY_FIELDS, TOOL_SETTER_AXES, probeDefaults, withToolSetterAxis } from './ProbingArea'
import { statedCoolantRole } from './OutputsSection'
import { vfdPathKey, type VfdPath } from './SpindleLinkSection'
import { VFD_MODEL_TEMPLATES } from '../../../lib/machine/vfd'
import { declareMachineVfdLink } from '../../../lib/machine/machineSession'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'

/**
 * WO-1689 - EVERY CONTROLLER SETTING IN ONE SEARCHABLE TABLE (v2/SLICES.md T6).
 * WO-1720 - AND "ALL" MEANS ALL. Operator ruling 2026-09-19: "legacy versus ALL makes no
 * sense. How can legacy show more settings that ALL settings ... No legacy, and
 * all means ALL."
 *
 * WHAT WAS MISSING, measured on his imported LienCNC V2: the table listed all
 * 1681 catalogue keys but drew a value for only the 1489 held in
 * `ControllerDefinition.settings`. The other 191 - steps, velocity, soft
 * limits, every axis pin, homing, the e-stop and probe wires - live on the
 * definition's NAMED fields (`axes`, `homing`, `io`), `SettingBox` rightly
 * refuses to be their second writer (`ownedElsewhere`), and so their rows came
 * out blank. The machine facts that are not `.pro` keys at all - the outputs
 * list, G30 parks, spindle range, probe feeds - were not in the table at all.
 *
 * FOUR KINDS OF ROW, ONE TABLE, ONE WRITER PER FACT:
 *
 *   uccnc   a catalogue key the definition holds in `settings`. Drawn by
 *           `SettingBox` through `unsent`, exactly as before.
 *   named   a catalogue key a named field owns. Its VALUE is read through
 *           `exportUccncProfile` - the one place the importer's conversions
 *           are inverted (10 ms enable-delay steps, `None` for no slave, the
 *           homing sequence slots) - so this table cannot disagree with the
 *           file it would write. Its EDIT goes through the same panel writer
 *           the Machine / Probing / Controller area calls (`patchAxis`,
 *           `patchAxisPin`, `patchIoPin`, `patchHoming`, ...), never a
 *           second copy of any of them. On a machine that is not UCCNC the
 *           same named fields are listed under their plain names, because the
 *           areas edit them on every controller.
 *   grbl    a stated `$`-setting, written through `recordGrblSettings`.
 *   app     a fact this app keeps on the machine record that no controller
 *           file carries - spindle range and direction, probe feeds, outputs,
 *           G30 parks, a non-UCCNC Safe Z. Written the way its area writes it.
 *
 * WRITES REUSE THE EXISTING PATHS AND ADD NONE. See each writer below.
 *
 * A TEXT BOX RECORDS ONCE, ON BLUR OR ENTER - exactly as
 * `GrblSettingsTable`'s offline edit does. Recording every keystroke would
 * leave a half-typed prefix (backspacing "24000" -> spindle max 2) in a field
 * the post reads. Typed text is held per row key, never per row position, so
 * scrolling or filtering mid-edit cannot move it to another setting.
 */

type AllSettingsTableProps =
  Pick<MachineDefinitionPanelState, 'draft' | 'source' | 'unsent' | 'editDraft' | 'settingSearch'>
  & Partial<Pick<MachineDefinitionPanelState,
    | 'allSettingsTyped' | 'setAllSettingsTyped' | 'setSection'
    | 'patchAxis' | 'patchAxisPin' | 'patchIoPin' | 'patchHoming' | 'patchAxisSoftLimit'
    | 'setHomingOrderAt' | 'toggleAxisEnabled' | 'defineHoming' | 'vfdEdit'>>

type ShowFilter = 'everything' | 'stated' | 'changed'

/** Windowing constants. A row is one `<tr>` at a fixed height, so the window
 *  is a row count, not a pixel guess. */
const ROW_HEIGHT = 30
const OVERSCAN = 8

// ---------------------------------------------------------------------------
// THE ROWS
// ---------------------------------------------------------------------------

type RowSource = 'uccnc' | 'grbl' | 'named' | 'app' | 'profile'

/** Plain-kind of an app row's box. */
type AppKind = 'number' | 'text' | 'boolean' | 'enum' | 'readonly'

export interface AllSettingsRow {
  /** Row identity for test ids: `uccnc`, `uccnc-profile`, `grbl`, or
   *  `machine` (a named field or app fact that is not a key in this machine's
   *  controller file). */
  controller: string
  key: string
  group: string
  name: string
  kind: string
  unit: string
  meaning: string
  value: string | null
  visible: boolean
  source: RowSource
  /** False only for imported file values absent from the catalogue. */
  usedByLiencam: boolean
  /** The catalogue entry, for `uccnc` and `named` rows. */
  field?: ControllerSettingField
  /** The app fact, for `app` rows. */
  app?: AppField
}

/** The panel writers an edit may go through - the same ones the areas call. */
type Writers = Required<Pick<MachineDefinitionPanelState,
  | 'editDraft' | 'patchAxis' | 'patchAxisPin' | 'patchIoPin' | 'patchHoming'
  | 'patchAxisSoftLimit' | 'setHomingOrderAt' | 'toggleAxisEnabled' | 'defineHoming'>>
  & { draft: MachineConfig }

interface AppField {
  key: string
  group: string
  name: string
  unit: string
  meaning: string
  kind: AppKind
  options?: readonly string[]
  value: string | null
  /** Friendly words the enum select shows for a NULL value. The value stays
   *  null so the Stated filter reads absence honestly (WO-1732 correction);
   *  this label is display only and is never written or persisted. */
  unsetLabel?: string
  /** Where a read-only row's edit lives, when it has one. */
  area?: 'outputs' | 'spindle'
  /** A stored VFD-document leaf. Its edits use the Spindle area's one writer. */
  vfdPath?: VfdPath
  /** An explicitly absent VFD document uses the Spindle area's template writer. */
  vfdDrive?: boolean
  /** `directionInverted` has its own provenance-writing callback. */
  vfdDirection?: boolean
  write?: (text: string, w: Writers) => boolean
}

/** Every catalogue key a NAMED FIELD owns, bar the profile name. */
const NAMED_FIELDS = UCCNC_SETTING_FIELDS.filter((f) => f.ownedBy !== null)

/**
 * EVERY NAMED FIELD'S VALUE, IN THE CATALOGUE'S TERMS, read through the
 * exporter rather than a second copy of its inversions. The export writes a
 * key only when the definition STATES it, so each named key is handed to it
 * as stated: the question here is "what does the record hold", which is what
 * the areas show, not "has somebody chosen it", which the export gauge asks.
 * `settings` is left out because a key held there is a `uccnc` row and reads
 * itself; asking the export only about named fields also keeps this to one
 * pass over 217 keys instead of a 1681 x 1507 walk on every keystroke.
 */
function namedFieldValues(machine: MachineConfig): Map<string, string> {
  const values = new Map<string, string>()
  const def = machine.controllerDefinition
  if (!def) return values
  const { text } = exportUccncProfile(
    { ...def, settings: [], stated: NAMED_FIELDS.map((f) => ({ controller: 'uccnc' as const, key: f.key })) },
    { profileName: machine.name },
  )
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[') && line.endsWith(']')) { section = line.slice(1, -1); continue }
    const eq = line.indexOf('=')
    if (eq > 0) values.set(`${section}.${line.slice(0, eq)}`.toLowerCase(), line.slice(eq + 1))
  }
  // The exporter correctly refuses to round an odd millisecond count to a
  // whole UCCNC 10 ms step. All settings is an editor, though, and can show
  // and write the exact fractional step without changing the stored delay.
  for (const field of NAMED_FIELDS) {
    const match = /^axes\[([XYZABC])\]\.enableDelayMs$/.exec(field.ownedBy ?? '')
    if (!match || values.has(field.key.toLowerCase())) continue
    const axis = def.axes.find((candidate) => candidate.axis === match[1])
    if (axis) values.set(field.key.toLowerCase(), String(axis.enableDelayMs / 10))
  }
  return values
}

const fmt = (n: number | null | undefined): string | null =>
  typeof n === 'number' && Number.isFinite(n) ? String(n) : null

const num = (text: string): number | null => {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

/** Probe feeds and geometry: `ProbingArea`'s own label lists, `ProbingArea`'s
 *  own write (`probeDefaults` merged, then the one field). The three fixed
 *  tool-setter coordinates (WO-1730) join them as app rows, written through
 *  `ProbingArea`'s one shared patch/delete writer - the same nested fact the
 *  Probing area edits, with blank kept absent and zero stated, negative
 *  allowed because machine coordinates go negative. */
function probingFields(machine: MachineConfig): AppField[] {
  const setterFields: AppField[] = TOOL_SETTER_AXES.map((axis) => ({
    key: `probing.toolSetter.${axis}`,
    group: 'Probing',
    name: `Tool setter position ${axis.toUpperCase()}`,
    unit: 'machine mm',
    meaning: `Where the fixed tool setter stands, ${axis.toUpperCase()} in machine coordinates - `
      + 'Measure tool goes here. Blank leaves the axis unstated; 0 is a stated coordinate.',
    kind: 'number' as const,
    value: fmt(machine.probing?.toolSetter?.[axis]),
    write: (text: string, w: Writers) => {
      const trimmed = text.trim()
      if (trimmed === '') {
        w.editDraft((m) => withToolSetterAxis(m, axis, undefined))
        return true
      }
      const v = num(trimmed)
      if (v === null) return false
      w.editDraft((m) => withToolSetterAxis(m, axis, v))
      return true
    },
  }))
  const feedGeometry: AppField[] = [...PROBING_FEED_FIELDS, ...PROBING_GEOMETRY_FIELDS].map(([label, field, unit]) => ({
    key: `probing.${field}`,
    group: 'Probing',
    name: label,
    unit,
    meaning: `${label} - the probe routines' ${field}, kept by this app on the machine record.`,
    kind: 'number' as const,
    value: fmt(machine.probing?.[field as keyof MachineProbeDefaults] as number | undefined),
    write: (text: string, w: Writers) => {
      const v = num(text)
      if (v === null || v < 0) return false
      w.editDraft((m) => ({ ...m, probing: { ...probeDefaults(m), [field]: v } }))
      return true
    },
  }))
  return [...feedGeometry, ...setterFields]
}

/** Spindle range and direction: `SpindleArea`'s writes. */
function spindleFields(machine: MachineConfig): AppField[] {
  return [
    {
      key: 'spindle.maxRpm', group: 'Spindle', name: 'Maximum RPM', unit: 'rpm', kind: 'number',
      meaning: 'The fastest this spindle turns - the CAM half of the record.',
      value: fmt(machine.maxSpindleRpm),
      write: (text, w) => {
        const v = num(text); if (v === null) return false
        w.editDraft((m) => ({ ...m, maxSpindleRpm: Math.round(v) })); return true
      },
    },
    {
      key: 'spindle.minRpm', group: 'Spindle', name: 'Minimum RPM', unit: 'rpm', kind: 'number',
      meaning: 'The slowest this spindle turns - the CAM half of the record.',
      value: fmt(machine.minSpindleRpm),
      write: (text, w) => {
        const v = num(text); if (v === null) return false
        w.editDraft((m) => ({ ...m, minSpindleRpm: Math.round(v) })); return true
      },
    },
    {
      key: 'spindle.direction', group: 'Spindle', name: 'Direction', unit: 'none', kind: 'enum',
      options: ['cw', 'ccw'],
      meaning: 'Which way M3 turns this spindle.',
      value: machine.spindleDirection ?? null,
      write: (text, w) => {
        if (text !== 'cw' && text !== 'ccw') return false
        w.editDraft((m) => ({ ...m, spindleDirection: text })); return true
      },
    },
  ]
}

const spindleLinkValue = (value: string | number | boolean | null): string | null => {
  if (value === null) return null
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return String(value)
}

/** Every scalar fact in the stored VFD document. Object and array containers
 *  are shape, not settings; their leaves are the values the Spindle area
 *  shows and edits. This deliberately walks the stored document rather than
 *  maintaining a second field list that can drift when the VFD schema grows. */
function spindleLinkFields(machine: MachineConfig): AppField[] {
  const definition = machine.spindleLinkDefinition
  if (definition === undefined) return []
  if (definition === null) {
    return [{
      key: 'spindleLinkDefinition', group: 'Spindle VFD link', name: 'VFD link', unit: 'none',
      kind: 'enum', value: 'none', vfdDrive: true,
      meaning: 'This machine explicitly states that it has no stored VFD link.',
    }]
  }

  const rows: AppField[] = []
  const visit = (value: unknown, path: (string | number)[]) => {
    if (value === undefined) return
    if (value !== null && typeof value === 'object') {
      const entries = Array.isArray(value)
        ? value.map((entry, index) => [index, entry] as const)
        : Object.entries(value)
      for (const [part, entry] of entries) visit(entry, [...path, part])
      return
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && value !== null) return
    const key = `spindleLinkDefinition.${vfdPathKey(path)}`
    const leaf = String(path[path.length - 1])
    rows.push({
      key,
      group: 'Spindle VFD link',
      name: `VFD ${path.map(String).join(' / ')}`,
      unit: /Ms$/.test(leaf) ? 'ms' : leaf === 'baud' ? 'baud' : leaf === 'upToSpeedToleranceRpm' ? 'rpm' : 'none',
      kind: typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'text',
      meaning: `Stored VFD link field ${vfdPathKey(path)}; edited through the Spindle area's VFD document.`,
      value: spindleLinkValue(value),
      area: 'spindle',
      vfdPath: path,
      vfdDirection: path.length === 1 && path[0] === 'directionInverted',
    })
  }
  visit(definition, [])
  return rows
}

/** The outputs list, one row per fact per output. Every row writes the same
 *  `controllerDefinition.outputs` entry the Outputs area writes. Role changes
 *  also update the one coolant-capability answer, exactly as that area does. */
function outputFields(machine: MachineConfig): AppField[] {
  const outputs = machine.controllerDefinition?.outputs ?? []
  const patch = (index: number, mut: (o: (typeof outputs)[number]) => (typeof outputs)[number]) =>
    (w: Writers) => {
      w.editDraft((m) => (m.controllerDefinition
        ? {
            ...m,
            controllerDefinition: {
              ...m.controllerDefinition,
              outputs: (m.controllerDefinition.outputs ?? []).map((o, i) => (i === index ? mut(o) : o)),
            },
          }
        : m))
    }
  const rows: AppField[] = []
  outputs.forEach((output, index) => {
    const label = `Output ${index + 1}`
    const base = { group: 'Outputs and coolant', unit: 'none' as string }
    const pinPart = (part: 'port' | 'pin' | 'negate'): AppField => ({
      ...base,
      key: `outputs.${index}.pin.${part}`,
      name: `${label} pin ${part}`,
      kind: part === 'negate' ? 'boolean' : 'number',
      meaning: `${output.name || label}: the ${part === 'negate' ? 'polarity (active low)' : part} of the pin it switches.`,
      value: part === 'negate'
        ? (output.pin.negate === null ? null : output.pin.negate ? 'True' : 'False')
        : String(output.pin[part]),
      write: (text, w) => {
        if (part === 'negate') {
          patch(index, (o) => ({ ...o, pin: { ...o.pin, negate: text === 'True' } }))(w)
          return true
        }
        const v = num(text)
        if (v === null || v < 0 || !Number.isInteger(v)) return false
        patch(index, (o) => ({ ...o, pin: { ...o.pin, [part]: v } }))(w)
        return true
      },
    })
    rows.push(
      {
        ...base, key: `outputs.${index}.name`, name: `${label} name`, kind: 'text',
        meaning: 'What this output is called on the page and in the console.',
        value: output.name,
        write: (text, w) => { patch(index, (o) => ({ ...o, name: text }))(w); return true },
      },
      {
        ...base, key: `outputs.${index}.onCode`, name: `${label} on code`, kind: 'text',
        meaning: 'The M-code that switches this output on.',
        value: output.onCode,
        write: (text, w) => {
          const code = normalizeMachineMCode(text.trim())
          if (code === null) return false
          patch(index, (o) => ({ ...o, onCode: code }))(w); return true
        },
      },
      {
        ...base, key: `outputs.${index}.offCode`, name: `${label} off code`, kind: 'text',
        meaning: 'The M-code that switches this output off; blank means the shared stop word only.',
        value: output.offCode,
        write: (text, w) => {
          const trimmed = text.trim()
          const code: MachineMCode | null = trimmed === '' ? null : normalizeMachineMCode(trimmed)
          if (trimmed !== '' && code === null) return false
          patch(index, (o) => ({ ...o, offCode: code }))(w); return true
        },
      },
      pinPart('port'),
      pinPart('pin'),
      pinPart('negate'),
      {
        ...base, key: `outputs.${index}.role`, name: `${label} CAM role`, kind: 'enum',
        options: ['', 'flood', 'mist', 'vacuum'],
        meaning: 'Which coolant channel this output is; blank means it is switched only by'
          + ' its own word, or its imported role is wiring evidence nobody has confirmed yet.',
        // WO-1777 phase 2: THE SAME ANSWER THE OUTPUTS AREA GIVES. This row
        // used to carry its own inline copy of the old predicate, so the All
        // settings table showed an imported Flood/Mist role while the record
        // stated nothing - the contradiction the Outputs column just fixed.
        // It now reads the one rule (`statedCoolantRole`, whose comment holds
        // the whole history) off the same `statedCoolantCapability` authority.
        // Display-only: the stored role, pin and word are untouched, and the
        // writer below still states Yes through `withEnabledCoolantCapability`
        // in one real change event.
        value: statedCoolantRole(machine, output.role) || null,
        write: (text, w) => {
          if (text !== '' && text !== 'flood' && text !== 'mist' && text !== 'vacuum') return false
          const role = text as CoolantChannel | ''
          w.editDraft((m) => {
            const current = m.controllerDefinition?.outputs ?? []
            const previousRole = current[index]?.role
            const nextOutputs = current.map((o, i) => {
              if (i === index) return { ...o, role: role === '' ? undefined : role }
              return role !== '' && o.role === role ? { ...o, role: undefined } : o
            })
            let next = m.controllerDefinition
              ? { ...m, controllerDefinition: { ...m.controllerDefinition, outputs: nextOutputs } }
              : m
            const stillListed = (channel: CoolantChannel) => nextOutputs.some((o) => o.role === channel)
            if (role === 'mist' || role === 'flood') next = withEnabledCoolantCapability(next, role)
            if ((previousRole === 'mist' || previousRole === 'flood')
              && previousRole !== role && !stillListed(previousRole)) {
              next = withCoolantCapability(next, previousRole, false)
            }
            if (previousRole === 'vacuum' && role !== 'vacuum' && !stillListed('vacuum')) {
              next = withVacuumCapability(next, false)
            }
            return next
          })
          return true
        },
      },
      {
        ...base, key: `outputs.${index}.onDelayMs`, name: `${label} on delay`, unit: 'ms', kind: 'number',
        meaning: 'How long to wait after switching this output on.',
        value: fmt(output.onDelayMs ?? 0),
        write: (text, w) => {
          const v = num(text); if (v === null || v < 0) return false
          patch(index, (o) => ({ ...o, onDelayMs: v === 0 ? undefined : v }))(w); return true
        },
      },
      ...(output.sharedSwitch === undefined ? [{
        ...base, key: `outputs.${index}.inUse`, name: `${label} in use`, kind: 'boolean',
        meaning: 'Whether this controller output is active; its wiring remains stated when it is off.',
        value: output.disabled === true ? 'False' : 'True',
        write: (text, w) => {
          patch(index, (o) => ({ ...o, disabled: text === 'True' ? undefined : true }))(w); return true
        },
      } satisfies AppField] : []),
    )
  })
  // The shared relay switch (`Floodmistrelaysenabled`): one control per
  // group, on if ANY member is on - `OutputsSection.setGroupInUse`'s rule.
  const groups = [...new Set(outputs.flatMap((o) => (o.sharedSwitch === undefined ? [] : [o.sharedSwitch])))]
  for (const group of groups) {
    const members = outputs.filter((o) => o.sharedSwitch === group)
    rows.push({
      key: `outputs.shared.${group}`, group: 'Outputs and coolant', unit: 'none', kind: 'boolean',
      name: `${group} in use`,
      meaning: `The controller switches ${members.map((o) => o.onCode).join(' and ')} with one setting; this turns them on or off together.`,
      value: members.some((o) => !o.disabled) ? 'True' : 'False',
      write: (text, w) => {
        const inUse = text === 'True'
        w.editDraft((m) => (m.controllerDefinition
          ? {
              ...m,
              controllerDefinition: {
                ...m.controllerDefinition,
                outputs: (m.controllerDefinition.outputs ?? []).map((o) => (o.sharedSwitch === group
                  ? { ...o, disabled: inUse ? undefined : true }
                  : o)),
              },
            }
          : m))
        return true
      },
    })
  }
  return rows
}

/** G30 parks P1..P4. A macro-backed park edits that macro's one `goTo` body;
 *  a typed/imported park edits `referencePositions`, the same two facts the
 *  Macros panel and the old Travel & Homing table respectively own. */
function parkFields(machine: MachineConfig): AppField[] {
  const positions = machineReferencePositions(machine)
  const positionMacros = (machine.macros ?? [])
    .map((macro, index) => ({ index, fields: parsePositionMacroBody(macro.body) }))
    .filter((entry): entry is { index: number; fields: NonNullable<typeof entry.fields> } => entry.fields !== null)
  const fromMacros = positionMacros.length > 0
  const rows: AppField[] = []
  for (const n of [1, 2, 3, 4] as MachineReferencePositionNumber[]) {
    for (const axis of ['x', 'y', 'z'] as const) {
      rows.push({
        key: `park.P${n}.${axis}`,
        group: 'Park positions (G30)',
        name: `P${n} ${axis.toUpperCase()}`,
        unit: 'mm',
        kind: !fromMacros || positionMacros[n - 1] ? 'number' : 'readonly',
        meaning: fromMacros
          ? `G30 P${n}, machine coordinates - set by this machine's position macro, edited on the Macros panel.`
          : `G30 P${n}, machine coordinates. G30.1 stores P1 at the current position.`,
        value: fmt(positions?.[n]?.[axis]),
        write: fromMacros && positionMacros[n - 1] ? (text, w) => {
          const v = num(text); if (v === null) return false
          w.editDraft((m) => {
            const entry = (m.macros ?? [])
              .map((macro, index) => ({ index, fields: parsePositionMacroBody(macro.body) }))
              .filter((candidate): candidate is { index: number; fields: NonNullable<typeof candidate.fields> } => candidate.fields !== null)[n - 1]
            if (!entry) return m
            return {
              ...m,
              macros: (m.macros ?? []).map((macro, index) => index === entry.index
                ? { ...macro, body: positionMacroBody({ ...entry.fields, [axis]: v }) }
                : macro),
            }
          })
          return true
        } : fromMacros ? undefined : (text, w) => {
          const v = num(text); if (v === null) return false
          w.editDraft((m) => {
            const current = machineReferencePositions(m) ?? {}
            const point = current[n] ?? { x: 0, y: 0, z: 0 }
            return { ...m, referencePositions: { ...current, [n]: { ...point, [axis]: v } } }
          })
          return true
        },
      })
    }
  }
  return rows
}

/** WO-2437: where an operator stop parks - the machine's own setting, the
 *  same value the Park positions section edits, through the one writer. */
function operatorStopParkFields(machine: MachineConfig): AppField[] {
  const set = machine.operatorStopPark ?? null
  return (['x', 'y', 'z'] as const).map((axis): AppField => ({
    key: `park.operatorStop.${axis}`,
    group: 'Park positions (G30)',
    name: `Operator stop ${axis.toUpperCase()}`,
    unit: 'mm',
    kind: 'number',
    meaning: 'Where an operator stop parks, machine coordinates - the posted stop and Control\'s clamp pause both go here. '
      + 'Empty: the machine\'s Park 1.',
    value: fmt(set?.[axis]),
    write: (text, w) => {
      const trimmed = text.trim()
      const v = trimmed === '' ? null : num(trimmed)
      if (trimmed !== '' && v === null) return false
      w.editDraft((m) => withOperatorStopParkAxis(m, axis, v)); return true
    },
  }))
}

/** The one app writer for Safe Z, with the row identity its authority uses. */
function safeZAppField(machine: MachineConfig, key: string): AppField {
  return {
    key, group: 'Machine', name: 'Safe Z', unit: 'mm', kind: 'number',
    meaning: 'Machine-coordinate Z every rapid clears to, typed on this machine.',
    value: fmt(machineSafeZ(machine)?.z),
    write: (text, w) => {
      const trimmed = text.trim()
      const v = trimmed === '' ? null : num(trimmed)
      if (trimmed !== '' && v === null) return false
      w.editDraft((m) => withMachineSafeZ(m, v)); return true
    },
  }
}

/** Safe Z is app-owned unless a UCCNC profile setting owns it. A definition
 * app key is already indexed below and reuses this writer there, so it must
 * not also grow a second `machine.safeZ` row. */
function safeZField(machine: MachineConfig): AppField[] {
  if (definitionStatesKeyInSettings(machine, UCCNC_SAFE_Z_KEY)) return []
  const def = machine.controllerDefinition
  if (def && definitionStatesKey({ settings: def.settings, stated: [] }, machine.controller, LIENCAM_SAFE_Z_KEY)) {
    return []
  }
  return [safeZAppField(machine, 'machine.safeZ')]
}

/** WO-1732 - the board this definition DECLARES, as one app row. It is the
 *  SAME optional fact the Controller area edits (`controllerBoard.deviceType`)
 *  written by the SAME shared writer (`withUccncBoardDeviceType`), named from
 *  the ONE helper table - a second door, never a second fact. Only UCCNC has
 *  this fact; another controller's table does not borrow it. A stored type
 *  the table does not know is shown as what it is and survives untouched
 *  edits verbatim, never converted to a default or to absence. */
function controllerBoardField(machine: MachineConfig): AppField[] {
  if (machine.controller !== 'uccnc') return []
  const raw = machine.controllerBoard?.deviceType
  const stated = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  const known = stated === null ? null : uccncBoardName(stated)
  const unknownLabel = stated !== null && known === null ? uccncBoardUnknownName(stated) : null
  return [{
    key: 'machine.controllerBoard', group: 'Machine', name: 'Controller board',
    unit: 'none', kind: 'enum',
    meaning: 'Which CNCdrive board this machine\'s definition declares - '
      + 'the same fact the Controller area edits.',
    // The unset row's VALUE stays null: the Stated filter reads
    // `value !== null`, so an absent fact must not pose as stated (WO-1732
    // architect correction). "Not stated" is the DISPLAY of that null, via
    // `unsetLabel`, never a sentinel in the value. The explicit 'Not stated'
    // choice exists only while something IS stated - that is how the row
    // clears the fact; once absent, the row already reads 'Not stated'.
    options: [
      ...(stated === null ? [] : ['Not stated']),
      ...(unknownLabel === null ? [] : [unknownLabel]),
      ...uccncBoardOptions().map((option) => option.name),
    ],
    value: stated === null ? null : known ?? unknownLabel,
    unsetLabel: 'Not stated',
    write: (text, w) => {
      const trimmed = text.trim()
      if (trimmed === 'Not stated') {
        w.editDraft((m) => withUccncBoardDeviceType(m, null))
        return true
      }
      const deviceType = uccncBoardDeviceTypeByName(trimmed)
      if (deviceType !== null) {
        w.editDraft((m) => withUccncBoardDeviceType(m, deviceType))
        return true
      }
      // Re-choosing the row's own unknown label keeps the stored number as is.
      return unknownLabel !== null && trimmed === unknownLabel
    },
  }]
}

function appFields(machine: MachineConfig): AppField[] {
  return [
    ...safeZField(machine),
    ...controllerBoardField(machine),
    ...spindleFields(machine),
    ...spindleLinkFields(machine),
    ...outputFields(machine),
    ...probingFields(machine),
    ...parkFields(machine),
    ...operatorStopParkFields(machine),
  ]
}

/**
 * EVERY ROW THIS MACHINE'S ALL SETTINGS SHOWS, value and all. Built for the
 * draft and again for the saved record, so "Changed by me" compares like with
 * like.
 */
export function buildAllSettingsRows(machine: MachineConfig): AllSettingsRow[] {
  const def = machine.controllerDefinition
  const named = def ? namedFieldValues(machine) : new Map<string, string>()
  const byKey = new Map(UCCNC_SETTING_FIELDS.map((f) => [f.key, f]))
  const rows: AllSettingsRow[] = []

  if (machine.controller === 'uccnc') {
    for (const row of buildSettingsIndex(machine)) {
      if (row.key === LIENCAM_SAFE_Z_KEY) {
        const app = safeZAppField(machine, LIENCAM_SAFE_Z_KEY)
        rows.push({
          ...row,
          controller: 'machine',
          group: app.group,
          name: app.name,
          meaning: app.meaning,
          value: app.value,
          source: 'app',
          usedByLiencam: true,
          app,
        })
        continue
      }
      const field = byKey.get(row.key)
      const isNamed = row.value === null && field?.ownedBy != null
        && !definitionStatesKeyInSettings(machine, row.key)
      rows.push({
        ...row,
        controller: 'uccnc',
        source: isNamed ? 'named' : 'uccnc',
        usedByLiencam: true,
        field,
        value: isNamed ? named.get(row.key.toLowerCase()) ?? null : row.value,
      })
    }
  } else {
    for (const row of buildSettingsIndex(machine)) {
      if (row.key === LIENCAM_SAFE_Z_KEY) {
        const app = safeZAppField(machine, LIENCAM_SAFE_Z_KEY)
        rows.push({
          ...row,
          controller: 'machine',
          group: app.group,
          name: app.name,
          meaning: app.meaning,
          value: app.value,
          source: 'app',
          usedByLiencam: true,
          app,
        })
      } else if (row.key.startsWith('liencam.')) {
        // An app key is never a `$` register. Unknown future app facts remain
        // visible read-only until their owning area supplies an edit door.
        const app: AppField = {
          key: row.key,
          group: row.group,
          name: row.name,
          unit: row.unit,
          meaning: row.meaning,
          kind: 'readonly',
          value: row.value,
        }
        rows.push({ ...row, controller: 'machine', source: 'app', usedByLiencam: true, app })
      } else {
        rows.push({ ...row, controller: row.controller, source: 'grbl', usedByLiencam: true })
      }
    }
    // THE NAMED FIELDS ARE THE AREAS' ON EVERY CONTROLLER. Listed through the
    // UCCNC catalogue's metadata (group, name, unit, meaning) because that is
    // the one description of them this software has; the key is only a row
    // identity here, never a setting written into another controller's file.
    if (def) {
      const meta = new Map(buildSettingsIndex({ ...machine, controller: 'uccnc' }).map((r) => [r.key, r]))
      for (const field of NAMED_FIELDS) {
        if (field.ownedBy === 'MachineConfig.name') continue
        const m = meta.get(field.key)
        if (!m) continue
        rows.push({
          ...m,
          controller: 'machine',
          name: `${m.name} (${field.ownedBy})`,
          source: 'named',
          usedByLiencam: true,
          field,
          value: named.get(field.key.toLowerCase()) ?? null,
        })
      }
    }
  }

  // The imported file's remaining keys are UCCNC application state, not
  // machine-definition inputs. They are deliberately plain read-only text:
  // showing the file does not create a second writer or make LienCAM depend
  // on a screen-set, hotkey, live coordinate, statistic, or tool-table value.
  if (machine.controller === 'uccnc') {
    for (const setting of uccncProfileOnlySettings(def)) {
      rows.push({
        controller: 'uccnc-profile',
        key: `${setting.section}.${setting.key}`,
        group: setting.section,
        name: setting.key,
        kind: 'readonly',
        unit: 'none',
        meaning: 'Not used by LienCAM.',
        value: setting.value,
        visible: true,
        source: 'profile',
        usedByLiencam: false,
      })
    }
  }

  for (const app of appFields(machine)) {
    rows.push({
      controller: 'machine',
      key: app.key,
      group: app.group,
      name: app.name,
      kind: app.kind,
      unit: app.unit,
      meaning: app.meaning,
      value: app.value,
      visible: true,
      source: 'app',
      usedByLiencam: true,
      app,
    })
  }
  return rows
}

/** Is the key held in `settings` itself (a released polarity, say)? Then it
 *  is `SettingBox`'s row, whatever the catalogue's `ownedBy` says - the same
 *  rule `SettingSource.ownedElsewhere` answers. */
function definitionStatesKeyInSettings(machine: MachineConfig, key: string): boolean {
  const def = machine.controllerDefinition
  return Boolean(def && definitionStatesKey({ settings: def.settings, stated: [] }, 'uccnc', key))
}

// ---------------------------------------------------------------------------
// THE NAMED-FIELD WRITER - the inverse of `heldValue`, dispatched to the SAME
// panel writer the owning area calls.
// ---------------------------------------------------------------------------

const AXIS_PATH = /^axes\[([XYZABC])\]\.(\w+)(?:\.(\w+))?$/
const HOMING_PATH = /^homing\.perAxis\[([XYZABC])\]\.(\w+)$/
const IO_PATH = /^io\.(estop|probe|probe2)\.(port|pin|negate)$/

interface GrblNamedAuthority {
  value: string | null
}

/** The exact board-ownership rule MachineArea uses. When GRBL states one of
 *  these values, the named field is its planning mirror, not another edit
 *  door. Read from the live board while connected and otherwise from the
 *  record, just as MachineArea does. */
function grblNamedAuthority(
  row: AllSettingsRow,
  machine: MachineConfig,
  settings: GrblSettingsRecord,
): GrblNamedAuthority | null {
  if (row.source !== 'named' || !row.field?.ownedBy || !controllerSurface(machine).grblSettings) return null
  const raw = (id: number): string | null => settings[id] ?? null
  const offsetFor = (axis: AxisName): number | null =>
    axis === 'X' ? 0 : axis === 'Y' ? 1 : axis === 'Z' ? 2 : null
  const hasTravelHoming = [20, 21, 22, 23, 24, 25, 26, 27, 130, 131, 132]
    .some((id) => raw(id) !== null)

  const axisMatch = AXIS_PATH.exec(row.field.ownedBy)
  if (axisMatch) {
    const axis = axisMatch[1] as AxisName
    const prop = axisMatch[2]
    const part = axisMatch[3]
    const offset = offsetFor(axis)
    if (offset === null) return null
    const bases: Record<string, number> = { stepsPerUnit: 100, maxVelocity: 110, acceleration: 120 }
    if (prop in bases) {
      const value = raw(bases[prop] + offset)
      return value === null ? null : { value }
    }
    if ((prop === 'softLimitMin' || prop === 'softLimitMax') && hasTravelHoming) {
      const travel = raw(130 + offset)
      const magnitude = travel === null ? null : Number(travel)
      return {
        value: magnitude === null || !Number.isFinite(magnitude)
          ? row.value
          : prop === 'softLimitMin' ? String(-Math.abs(magnitude)) : '0',
      }
    }
    if (part === 'negate' && prop === 'dirPin') {
      const value = grblMaskBit(settings, 3, offset)
      return value === null ? null : { value: value ? 'True' : 'False' }
    }
    if (part === 'negate' && ['homePin', 'limitMinusPin', 'limitPlusPin'].includes(prop)) {
      const value = grblFlag(settings, 5)
      return value === null ? null : { value: value ? 'True' : 'False' }
    }
    return null
  }

  const homingMatch = HOMING_PATH.exec(row.field.ownedBy)
  if (!homingMatch || !hasTravelHoming) return null
  const axis = homingMatch[1] as AxisName
  const prop = homingMatch[2]
  const offset = offsetFor(axis)
  if (offset === null) return null
  if (prop === 'direction') {
    const value = grblMaskBit(settings, 23, offset)
    return { value: value === null ? null : value ? 'True' : 'False' }
  }
  const setting = prop === 'slowSpeed' ? 24 : prop === 'fastSpeed' ? 25 : prop === 'backOff' ? 27 : null
  return setting === null ? null : { value: raw(setting) }
}

/** Write one catalogue-described value into the named field that owns it.
 *  Returns false when the text is not a value this key can hold - the box
 *  keeps it and says so, and the record keeps what it had. */
export function writeNamedField(field: ControllerSettingField, text: string, w: Writers): boolean {
  const parsed = parseUccncSettingValue(field, text.trim())
  if (!parsed.ok || parsed.value.kind === 'tuple') return false
  const scalar = parsed.value.value
  const path = field.ownedBy ?? ''
  const def = w.draft.controllerDefinition
  if (!def) return false

  if (path === 'MachineConfig.name') {
    w.editDraft((m) => ({ ...m, name: String(scalar) }))
    return true
  }

  if (path === 'homing.order') {
    const slot = Number(field.key.replace(/^.*Homesequence/, ''))
    if (!Number.isInteger(slot) || slot < 1) return false
    if (scalar === 'None') {
      w.editDraft((m) => (m.controllerDefinition
        ? {
            ...m,
            controllerDefinition: {
              ...m.controllerDefinition,
              homing: {
                ...m.controllerDefinition.homing,
                order: m.controllerDefinition.homing.order.filter((_, index) => index !== slot - 1),
              },
            },
          }
        : m))
    } else {
      // `setHomingOrderAt` swaps, so the order stays a permutation. A slot past
      // the end of a short order lands at its end rather than leaving a hole.
      w.setHomingOrderAt(Math.min(slot - 1, def.homing.order.length), scalar as AxisName)
    }
    return recordStated(field, w)
  }

  const axisMatch = AXIS_PATH.exec(path)
  if (axisMatch) {
    const axis = axisMatch[1] as AxisName
    const prop = axisMatch[2]
    const part = axisMatch[3]
    const current = def.axes.find((a) => a.axis === axis)
    if (!current) return false
    if (prop === 'enabled') w.toggleAxisEnabled(axis, scalar === true)
    else if (prop === 'softLimitMin' || prop === 'softLimitMax') {
      w.patchAxisSoftLimit(axis, prop === 'softLimitMin' ? 'min' : 'max', Number(scalar))
    } else if (prop === 'enableDelayMs') w.patchAxis(axis, { enableDelayMs: Number(scalar) * 10 })
    else if (prop === 'slaveAxis') {
      w.patchAxis(axis, { slaveAxis: scalar === 'None' ? null : scalar as AxisName })
    } else if (prop === 'backlash' && part !== undefined) {
      w.patchAxis(axis, { backlash: { ...current.backlash, [part]: scalar } as AxisDefinition['backlash'] })
    } else if (part !== undefined) {
      const pin = current[prop as keyof AxisDefinition] as PinRef | undefined
      if (!pin || typeof pin !== 'object') return false
      w.patchAxisPin(axis, prop as keyof AxisDefinition, { ...pin, [part]: scalar })
    } else {
      w.patchAxis(axis, { [prop]: scalar } as Partial<AxisDefinition>)
    }
    return recordStated(field, w)
  }

  const homingMatch = HOMING_PATH.exec(path)
  if (homingMatch) {
    const axis = homingMatch[1] as AxisName
    const prop = homingMatch[2]
    // `patchHoming` never conjures a missing block; `defineHoming` is the
    // area's own explicit step for that, taken here because typing a value
    // IS the explicit request.
    if (!def.homing.perAxis[axis]) w.defineHoming(axis)
    w.patchHoming(axis, prop === 'direction'
      ? { direction: scalar === true ? 'positive' : 'negative' }
      : { [prop]: scalar })
    return recordStated(field, w)
  }

  const ioMatch = IO_PATH.exec(path)
  if (ioMatch) {
    const which = ioMatch[1] as 'estop' | 'probe' | 'probe2'
    const part = ioMatch[2] as 'port' | 'pin' | 'negate'
    w.patchIoPin(which, { ...def.io[which], [part]: scalar })
    return recordStated(field, w)
  }
  return false
}

/** On a UCCNC machine an edit here is a statement, so the file this record
 *  exports carries it - the same provenance the importer records. */
function recordStated(field: ControllerSettingField, w: Writers): boolean {
  if (w.draft.controller !== 'uccnc') return true
  w.editDraft((m) => {
    const d = m.controllerDefinition
    if (!d || definitionStatesKey(d, 'uccnc', field.key)) return m
    return { ...m, controllerDefinition: { ...d, stated: [...(d.stated ?? []), { controller: 'uccnc', key: field.key }] } }
  })
  return true
}

// ---------------------------------------------------------------------------
// THE TABLE
// ---------------------------------------------------------------------------

const rowId = (row: Pick<AllSettingsRow, 'controller' | 'key'>) => `${row.controller}:${row.key}`

/** `searchSettingsIndex`'s rule - key, name, meaning or group contains the
 *  query, case-insensitive - over every row kind, not only catalogue rows. */
function searchSettingsIndex(rows: readonly AllSettingsRow[], query: string): AllSettingsRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...rows]
  return rows.filter((row) =>
    row.key.toLowerCase().includes(needle)
    || row.name.toLowerCase().includes(needle)
    || row.meaning.toLowerCase().includes(needle)
    || row.group.toLowerCase().includes(needle))
}

export function AllSettingsTable({
  draft,
  source,
  unsent,
  editDraft,
  settingSearch,
  allSettingsTyped,
  setAllSettingsTyped,
  setSection,
  patchAxis,
  patchAxisPin,
  patchIoPin,
  patchHoming,
  patchAxisSoftLimit,
  setHomingOrderAt,
  toggleAxisEnabled,
  defineHoming,
  vfdEdit,
}: AllSettingsTableProps) {
  const [group, setGroup] = useState('')
  const [show, setShow] = useState<ShowFilter>('everything')
  const [onlyUsed, setOnlyUsed] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  // Half-typed GRBL text, keyed by setting id ($-number). An id is present
  // only while its box holds text not yet recorded. The real panel owns this
  // state so its Revert and machine-switch boundaries can discard it. The
  // fallback keeps this component usable in its focused catalogue harnesses.
  const [localTyped, setLocalTyped] = useState<GrblSettingsRecord>({})
  const typed = allSettingsTyped ?? localTyped
  const setTyped = setAllSettingsTyped ?? setLocalTyped
  // Half-typed named-field and app-fact text, keyed by row id, and the ids
  // whose last recorded text was refused. Dropped on a machine switch.
  const [pending, setPending] = useState<Record<string, string>>({})
  const [refused, setRefused] = useState<Record<string, true>>({})
  useEffect(() => { setPending({}); setRefused({}) }, [draft.id])
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const connectionPhase = useMachineControl((state) => state.connectionPhase)
  const connectionKind = useMachineControl((state) => state.connectionKind)
  const reportedGrblSettings = useMachineControl((state) => state.settings)
  const grblConnected = connectionPhase === 'connected' && connectionKind === 'serial'
  const grblSettings = grblConnected
    ? reportedGrblSettings
    : (draft.grblSettings ?? {})

  // Measured, not assumed. jsdom (every test in this suite) never lays out a
  // real height, so `viewportHeight` stays 0 there and the fallback below
  // renders every matched row rather than nothing - a virtualised list that
  // shows zero rows in a size-less environment is the classic defect this
  // guards against, not a feature.
  useLayoutEffect(() => {
    const measure = () => { setViewportHeight(viewportRef.current?.clientHeight ?? 0) }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  const index = useMemo(() => buildAllSettingsRows(draft), [draft])
  // Plasma/laser/knife-only rows and unenabled-axis rotary rows stay in the
  // index (hidden is not deleted, WO-1695) - only this table's display reads
  // `visible`.
  const visibleIndex = useMemo(() => index.filter((row) => row.visible), [index])
  // The SAVED record's own rows, for the "changed by me" filter below - built
  // only when the saved record actually differs from the draft, so an
  // unedited page (the common case) computes the rows once, not twice.
  const savedIndex = useMemo(
    () => (source === draft ? index : buildAllSettingsRows(source)),
    [source, draft, index],
  )
  const savedValue = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const row of savedIndex) map.set(rowId(row), row.value)
    return map
  }, [savedIndex])

  // The .pro's own section names, in plain words, from the whole list - not
  // from what is currently matched, so picking a group never empties the
  // list of groups to pick from.
  const groups = useMemo(
    () => [...new Set(visibleIndex.map((row) => row.group))].sort((a, b) => a.localeCompare(b)),
    [visibleIndex],
  )

  const matchedBeforeUse = useMemo(() => {
    const searched = searchSettingsIndex(visibleIndex, settingSearch)
    return searched.filter((row) => {
      if (group !== '' && row.group !== group) return false
      if (show === 'stated') return row.value !== null
      // "Changed by me": this record's value for the row differs from the
      // last SAVED record's - the one diff this page can answer honestly
      // without a second, per-key provenance list nothing else keeps either.
      if (show === 'changed') return savedValue.get(rowId(row)) !== row.value
      return true
    })
  }, [visibleIndex, settingSearch, group, show, savedValue])
  const matched = useMemo(
    () => onlyUsed ? matchedBeforeUse.filter((row) => row.usedByLiencam) : matchedBeforeUse,
    [matchedBeforeUse, onlyUsed],
  )

  const rowCount = matched.length
  const windowed = viewportHeight > 0
  const visibleCount = windowed ? Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2 : rowCount
  const startIndex = windowed
    ? Math.max(0, Math.min(rowCount - visibleCount, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN))
    : 0
  const clampedStart = Math.max(0, startIndex)
  const endIndex = Math.min(rowCount, clampedStart + visibleCount)
  const visibleRows = matched.slice(clampedStart, endIndex)
  const estimatedScrollHeight = Math.max(viewportHeight, (rowCount + 1) * ROW_HEIGHT)
  const estimatedMaxScroll = Math.max(0, estimatedScrollHeight - viewportHeight)
  const scrollbarThumbHeight = viewportHeight > 0
    ? Math.max(32, viewportHeight * viewportHeight / estimatedScrollHeight)
    : 48
  const scrollbarThumbTop = estimatedMaxScroll > 0
    ? (viewportHeight - scrollbarThumbHeight) * Math.min(1, scrollTop / estimatedMaxScroll)
    : 0

  const setViewportScroll = (next: number) => {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollTop = Math.max(0, Math.min(next, viewport.scrollHeight - viewport.clientHeight))
    setScrollTop(viewport.scrollTop)
  }

  // A board-owned setting belongs to the BOARD, through either lens. Connected,
  // this takes the same write-and-read-back path the Machine area's GRBL table
  // takes and records what the controller returned - never the typed text - so
  // the app's number cannot drift from the board's (WO-1720 review round 2).
  // Disconnected it records locally and says it was not sent, exactly as that
  // table does. No new refusal either way.
  const writeGrblSetting = (key: string, text: string) => {
    const id = Number(key.slice(1))
    if (!grblConnected) {
      editDraft((m) => recordGrblSettings(m, { ...(m.grblSettings ?? {}), [id]: text }))
      console.log(`$${id} not sent - connect to apply.`)
      return
    }
    void writeGrblSettingAndReadBack(id, text).then((result) => {
      if (result.ok) {
        editDraft((m) => recordGrblSettings(m, { ...(m.grblSettings ?? {}), [id]: result.value }))
        console.log(`GRBL read back $${id}=${result.value}.`)
      } else {
        console.log(`Not sent: ${result.reason}`)
      }
    })
  }
  const grblRawValue = (key: string): string => draft.grblSettings?.[Number(key.slice(1))] ?? ''
  // Same rule as GrblSettingsTable's offline submit: trim, skip when unchanged,
  // otherwise record the whole value once.
  const submitGrblText = (key: string) => {
    const id = Number(key.slice(1))
    const text = typed[id]
    if (text === undefined) return
    setTyped((values) => {
      const next = { ...values }
      delete next[id]
      return next
    })
    const value = text.trim()
    if (value === (draft.grblSettings?.[id] ?? '')) return
    writeGrblSetting(key, value)
  }
  const grblIsTrue = (key: string): boolean => {
    const raw = grblRawValue(key)
    return raw !== '' && Number(raw) !== 0
  }

  // The panel's own writers. The focused harnesses that render this table
  // without the panel pass none; a named-field row there has nothing to write
  // through and draws its value read-only rather than inventing a writer.
  const writers: Writers | null = patchAxis && patchAxisPin && patchIoPin && patchHoming
    && patchAxisSoftLimit && setHomingOrderAt && toggleAxisEnabled && defineHoming
    ? {
        draft, editDraft, patchAxis, patchAxisPin, patchIoPin, patchHoming,
        patchAxisSoftLimit, setHomingOrderAt, toggleAxisEnabled, defineHoming,
      }
    : null

  const writeRow = (row: AllSettingsRow, text: string): boolean => {
    if (row.source === 'named' && row.field && writers) return writeNamedField(row.field, text, writers)
    if (row.source === 'app' && row.app?.write) {
      return row.app.write(text, writers ?? ({ draft, editDraft } as Writers))
    }
    return false
  }

  const commitRow = (row: AllSettingsRow, text: string) => {
    const id = rowId(row)
    setPending((p) => { const next = { ...p }; delete next[id]; return next })
    if (text.trim() === (row.value ?? '')) {
      setRefused((r) => { const next = { ...r }; delete next[id]; return next })
      return
    }
    const ok = writeRow(row, text)
    setRefused((r) => {
      const next = { ...r }
      if (ok) delete next[id]
      else next[id] = true
      return next
    })
    if (!ok) setPending((p) => ({ ...p, [id]: text }))
  }

  const editable = (row: AllSettingsRow): boolean =>
    row.source === 'named'
      ? writers !== null && grblNamedAuthority(row, draft, grblSettings) === null
      : row.app?.vfdPath !== undefined
        ? vfdEdit !== undefined
        : row.app?.write !== undefined

  const valueCell = (row: AllSettingsRow) => {
    if (row.source === 'uccnc') return <SettingBox label="" settingKey={row.key} settings={unsent} />
    if (row.source === 'grbl') {
      return row.kind === 'bool' ? (
        <input
          type="checkbox"
          aria-label={row.key}
          checked={grblIsTrue(row.key)}
          onChange={(e) => { writeGrblSetting(row.key, e.target.checked ? '1' : '0') }}
          style={{ margin: 0 }}
        />
      ) : (
        <input
          type="text"
          className="mform-input mform-input-mono"
          aria-label={row.key}
          value={typed[Number(row.key.slice(1))] ?? grblRawValue(row.key)}
          onChange={(e) => {
            const id = Number(row.key.slice(1))
            const text = e.target.value
            setTyped((values) => ({ ...values, [id]: text }))
          }}
          onBlur={() => { submitGrblText(row.key) }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            submitGrblText(row.key)
          }}
          style={{ width: '100%' }}
        />
      )
    }
    const id = rowId(row)
    const kind = row.source === 'named' ? row.field?.kind : row.app?.kind
    const grblAuthority = grblNamedAuthority(row, draft, grblSettings)
    if (grblAuthority !== null) {
      return (
        <span
          className="mform-input-mono"
          data-testid={`machine-def-all-settings-value-${row.controller}-${row.key}`}
        >
          {grblAuthority.value ?? ''}
        </span>
      )
    }
    if (row.app?.vfdDrive) {
      return (
        <select
          className="mform-select"
          aria-label={row.key}
          value="none"
          disabled={vfdEdit?.disabled === true}
          aria-disabled={vfdEdit?.disabled === true}
          onChange={(event) => {
            const templateId = event.target.value
            if (templateId !== 'none') void declareMachineVfdLink(source.id, templateId)
          }}
          style={{ width: '100%' }}
        >
          <option value="none">No VFD link - the controller drives the spindle</option>
          {VFD_MODEL_TEMPLATES.map((template) => (
            <option key={template.id} value={template.id}>{`Modbus VFD - ${template.label}`}</option>
          ))}
        </select>
      )
    }
    if (row.app?.vfdPath && vfdEdit) {
      const path = row.app.vfdPath
      const key = vfdPathKey(path)
      if (kind === 'boolean') {
        return (
          <input
            type="checkbox"
            aria-label={row.key}
            value={row.value ?? ''}
            checked={(vfdEdit.pending[key] ?? row.value) === 'True'}
            disabled={vfdEdit.disabled}
            aria-disabled={vfdEdit.disabled}
            onChange={(e) => {
              if (row.app?.vfdDirection) vfdEdit.onDirectionChange(e.target.checked)
              else vfdEdit.onCommit(path, e.target.checked ? 'True' : 'False')
            }}
            style={{ margin: 0 }}
          />
        )
      }
      return (
        <input
          type="text"
          className="mform-input mform-input-mono"
          aria-label={row.key}
          value={vfdEdit.pending[key] ?? row.value ?? ''}
          disabled={vfdEdit.disabled}
          aria-disabled={vfdEdit.disabled}
          onChange={(e) => { vfdEdit.onType(path, e.target.value) }}
          onBlur={(e) => { vfdEdit.onCommit(path, e.target.value) }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            vfdEdit.onCommit(path, e.currentTarget.value)
          }}
          style={{ width: '100%' }}
        />
      )
    }
    if (!editable(row) || kind === 'readonly') {
      return (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'baseline' }}>
          <span
            className="mform-input-mono"
            data-testid={`machine-def-all-settings-value-${row.controller}-${row.key}`}
          >
            {row.value ?? ''}
          </span>
          {row.app?.area && setSection && (
            <button
              type="button"
              className="control-chip-btn"
              data-tooltip={row.app.area === 'outputs' ? 'Edit on Outputs & coolant' : 'Edit on Spindle'}
              onClick={() => { setSection(row.app!.area!) }}
            >
              Edit
            </button>
          )}
        </span>
      )
    }
    if (kind === 'boolean') {
      return (
        <input
          type="checkbox"
          aria-label={row.key}
          value={row.value ?? ''}
          checked={row.value === 'True'}
          ref={(el) => { if (el) el.indeterminate = row.value === null }}
          onChange={(e) => { commitRow(row, e.target.checked ? 'True' : 'False') }}
          style={{ margin: 0 }}
        />
      )
    }
    const options = row.source === 'named' ? row.field?.options : row.app?.options
    if (kind === 'enum' && options) {
      return (
        <select
          aria-label={row.key}
          className="mform-select"
          value={row.value ?? ''}
          onChange={(e) => { commitRow(row, e.target.value) }}
        >
          {row.value === null && <option value="">{row.app?.unsetLabel ?? ''}</option>}
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )
    }
    return (
      <input
        type="text"
        className="mform-input mform-input-mono"
        aria-label={row.key}
        aria-invalid={refused[id] || undefined}
        value={pending[id] ?? row.value ?? ''}
        onChange={(e) => {
          const text = e.target.value
          setPending((p) => ({ ...p, [id]: text }))
        }}
        onBlur={() => { if (pending[id] !== undefined) commitRow(row, pending[id]) }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          if (pending[id] !== undefined) commitRow(row, pending[id])
        }}
        style={{ width: '100%', borderColor: refused[id] ? 'var(--accent-red)' : undefined }}
      />
    )
  }

  return (
    <div data-testid="machine-def-all-settings" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
        <label className="mform-label" htmlFor="machine-def-all-settings-group">Group</label>
        <select
          id="machine-def-all-settings-group"
          className="mform-select"
          data-testid="machine-def-all-settings-group"
          aria-label="Group"
          value={group}
          onChange={(e) => { setGroup(e.target.value) }}
        >
          <option value="">All groups</option>
          {groups.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <label className="mform-label" htmlFor="machine-def-all-settings-show">Show</label>
        <select
          id="machine-def-all-settings-show"
          className="mform-select"
          data-testid="machine-def-all-settings-show"
          aria-label="Show"
          value={show}
          onChange={(e) => { setShow(e.target.value as ShowFilter) }}
        >
          <option value="everything">Everything</option>
          <option value="stated">Stated by the profile</option>
          <option value="changed">Changed by me</option>
        </select>
        <label
          htmlFor="machine-def-all-settings-used-only"
          style={{ display: 'inline-flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}
        >
          <input
            id="machine-def-all-settings-used-only"
            data-testid="machine-def-all-settings-used-only"
            type="checkbox"
            checked={onlyUsed}
            onChange={(e) => { setOnlyUsed(e.target.checked); setScrollTop(0) }}
          />
          Only settings LienCAM uses
        </label>
        <span
          data-testid="machine-def-all-settings-count"
          role="status"
          style={{ marginLeft: 'auto', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}
        >
          {onlyUsed
            ? `${rowCount} of ${matchedBeforeUse.length} settings shown`
            : `${rowCount} setting${rowCount === 1 ? '' : 's'}`}
        </span>
      </div>
      <div style={{ position: 'relative', minWidth: 0 }}>
        <div
          ref={viewportRef}
          id="machine-def-all-settings-viewport"
          data-testid="machine-def-all-settings-viewport"
          style={{
            height: 480,
            overflowY: 'scroll',
            scrollbarGutter: 'stable',
            scrollbarColor: 'var(--text-muted) var(--surface-1)',
            minWidth: 0,
          }}
          onScroll={(e) => { setScrollTop(e.currentTarget.scrollTop) }}
        >
          <table
            className="mform-axis-table"
            data-testid="machine-def-all-settings-table"
            style={{ width: '100%', tableLayout: 'fixed' }}
          >
            <thead>
              <tr>
                <th style={{ width: 140 }}>Group</th>
                <th style={{ width: 220 }}>Setting</th>
                <th style={{ width: 200 }}>Value</th>
                <th style={{ width: 90 }}>Unit</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              {clampedStart > 0 && (
                <tr aria-hidden="true" style={{ height: clampedStart * ROW_HEIGHT }}>
                  <td colSpan={5} />
                </tr>
              )}
              {visibleRows.map((row) => (
                <tr
                  key={rowId(row)}
                  data-testid={`machine-def-all-settings-row-${row.controller}-${row.key}`}
                  data-row-source={row.source}
                  data-liencam-use={row.usedByLiencam ? 'used' : 'not-used'}
                >
                  <td>
                    {row.group}
                    {!row.usedByLiencam && (
                      <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                        Not used by LienCAM
                      </div>
                    )}
                  </td>
                  <td title={row.key}>{row.name}</td>
                  <td>{valueCell(row)}</td>
                  <td>{row.unit === 'none' ? '' : row.unit}</td>
                  <td
                    data-tooltip={row.meaning}
                    style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}
                  >
                    {row.meaning}
                  </td>
                </tr>
              ))}
              {endIndex < rowCount && (
                <tr aria-hidden="true" style={{ height: (rowCount - endIndex) * ROW_HEIGHT }}>
                  <td colSpan={5} />
                </tr>
              )}
            </tbody>
          </table>
          {rowCount === 0 && (
            <p className="mform-help" data-testid="machine-def-all-settings-empty">
              {settingSearch.trim() === ''
                ? 'This machine has no settings to list.'
                : `No setting matches "${settingSearch}".`}
            </p>
          )}
        </div>
        <div
          role="scrollbar"
          aria-label="All settings rows"
          aria-controls="machine-def-all-settings-viewport"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={Math.round(estimatedMaxScroll)}
          aria-valuenow={Math.round(Math.min(scrollTop, estimatedMaxScroll))}
          tabIndex={0}
          data-testid="machine-def-all-settings-scrollbar"
          onPointerDown={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0
            const viewport = viewportRef.current
            if (viewport) setViewportScroll(ratio * (viewport.scrollHeight - viewport.clientHeight))
          }}
          onKeyDown={(event) => {
            const viewport = viewportRef.current
            if (!viewport) return
            const steps: Record<string, number> = {
              ArrowUp: -ROW_HEIGHT,
              ArrowDown: ROW_HEIGHT,
              PageUp: -viewport.clientHeight,
              PageDown: viewport.clientHeight,
              Home: -Infinity,
              End: Infinity,
            }
            if (!(event.key in steps)) return
            event.preventDefault()
            const step = steps[event.key]
            setViewportScroll(step === -Infinity ? 0 : step === Infinity ? viewport.scrollHeight : viewport.scrollTop + step)
          }}
          style={{
            position: 'absolute',
            top: 2,
            right: 2,
            bottom: 2,
            width: 12,
            border: '1px solid var(--border-subtle)',
            borderRadius: 6,
            background: 'var(--surface-1)',
            boxSizing: 'border-box',
            cursor: 'pointer',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: Math.min(Math.max(0, scrollbarThumbTop), Math.max(0, viewportHeight - scrollbarThumbHeight)),
              left: 2,
              right: 2,
              height: Math.max(0, Math.min(viewportHeight - 4, scrollbarThumbHeight)),
              minHeight: 28,
              borderRadius: 4,
              background: 'var(--text-muted)',
            }}
          />
        </div>
      </div>
    </div>
  )
}
