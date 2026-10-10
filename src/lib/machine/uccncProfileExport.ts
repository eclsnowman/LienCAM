/**
 * WRITE A UCCNC `.pro` OUT OF A MACHINE DEFINITION - AND MEASURE WHAT IS
 * MISSING WHILE DOING IT (WO-1038, ADR-0044 requirements 4 and 5).
 *
 * THIS IS AN INSTRUMENT, NOT A FEATURE. Operator ruling 2026-08-26: *"if I made a
 * profile in our software, and exported the .pro, that if that were loaded
 * into UCCNC there would be no gaps... Thats how I can gauge that we have all
 * the required element in our UI to support all the capabilities UCCNC
 * possesses."* The file is how the gauge is read; the number is the point. So
 * every rule below is written to make a gap VISIBLE rather than to make the
 * file look finished:
 *
 *   - A key this definition cannot give back is ABSENT and REPORTED BY NAME.
 *     Never a default this software chose, never a zero, never a plausible
 *     value. That is `4dcf9701` (the invented home back-off) in a new
 *     container, and it reached Operator's machine once already.
 *   - Absence is never summarised into a count alone. `absent` carries the
 *     key and the reason, so the next order knows what to build.
 *   - There is no verbatim carrier of an imported document. ADR-0044
 *     Amendment 1 struck it by name: *"We don't need to house the .pro file
 *     in our system to feed it back out. Infact that is not the goal."* Text
 *     carried through untouched looks like coverage while proving none.
 *
 * THE ROUND TRIP IS CONTENT-IDENTICAL, NOT BYTE-IDENTICAL. Key order,
 * whitespace and numeric spelling are not facts about a machine - `0` and
 * `0.0000` are the same fact. The suite compares parsed key/value pairs.
 *
 * READ-ONLY STILL HOLDS (ADR-0044 requirement 1). Nothing here opens, seeks
 * or writes a path. It returns TEXT; the caller downloads it. A `.pro` on
 * disk belongs to UCCNC and this software has no authority over it.
 */

import type {
  AxisName,
  ControllerDefinition,
  ControllerSettingField,
  ControllerSettingValue,
  MachineControllerBoard,
} from '../../types'
import { controllerSettingValue, definitionStatesKey } from '../../types'
import { uccncBoardDeviceTypeByName } from './controllerBoard'
import {
  UCCNC_SETTING_FIELDS,
  formatUccncSettingValue,
  uccncSettingField,
  uccncProfileOnlySettings,
} from './uccncProfileImport'

/** UCCNC writes CRLF, and a text file's line ending is not a machine fact -
 *  it is what the reader on the other end expects. */
const EOL = '\r\n'

/**
 * THE SECTIONS THIS EXPORT DOES NOT MODEL - AND STILL HAS TO FILL IN
 * (ADR-0044 Amendment 1).
 *
 * A `.pro` also carries ~271 keys of LIVE RUNTIME STATE (tool table, work
 * offsets, machine coordinates, statistics) and ~362 of UCCNC's OWN
 * APPLICATION PREFERENCES (screenset, appearance, hotkeys, its CAM settings).
 * *"Those are not machine capabilities and are not part of the completeness
 * bar. An exported profile emits whatever valid values UCCNC needs to load,
 * and the UI never presents them."*
 *
 * SO THEY ARE EMITTED IN FULL, AND NONE OF THEM COUNTS. They never enter
 * `emitted`, so they cannot move the gap - a section that filled the file and
 * flattered the number would be the exact special case this instrument exists
 * to refuse.
 *
 * "VALID" IS NOT A GUESS HERE. Every baseline value is one UCCNC ITSELF WROTE
 * for that key, or the zero it writes for that key's family on a machine that
 * has not run - `TotaldistB=0`, `WorkoffsetA=0`, `ToolDia96=0`, `Keycode95=0`
 * all appear that way in a UCCNC-authored profile. `StateBasis` records which,
 * per section, as DATA rather than as prose, so the claim is testable and can
 * be argued with. Exactly one key is neither (`mainscreenfilename`) and it
 * says so.
 *
 * AND IT IS NOT A CARRIER OF ANYTHING IMPORTED - with one named exception.
 * Amendment 1 struck the verbatim carrier by name. This table is STATIC for
 * every key but one: the same bytes come out for a definition imported from
 * Operator's profile and for one built from nothing, so it never makes an
 * unmodelled key look covered. The exception is `Statistics.UCdevicetype`,
 * and it is only one because WO-1732 made the declared board a MODELLED
 * machine fact - carrying it is emitting a decoded identity, not untouched
 * text. The exported machine is not the exporting application; its stated
 * identity is preserved (WO-1805). A test holds the static rule for
 * everything else and names the exception exactly.
 *
 * WHAT IS STILL NOT PROVEN, and this order forbids claiming it: that UCCNC
 * opens the result. That needs UCCNC and a human.
 */

/** WHERE A BASELINE VALUE CAME FROM - the answer to "is it valid?", as data. */
export type StateBasis =
  /** The value for a machine that HAS NOT RUN. Zero distance travelled, zero
   *  tool offsets, work zero at machine zero, no hotkey bound. UCCNC writes
   *  exactly these zeros for these keys itself. */
  | 'unrun'
  /** A preference UCCNC ITSELF WROTE into a profile, transcribed once. It is
   *  UCCNC's own application setting, not a fact about anybody's machine. */
  | 'uccnc-written'
  /** The key set belongs to the USER'S INSTALL rather than to the machine -
   *  one key per DLL in their plugins folder. The empty list is the whole
   *  statement: nothing enabled. Naming plugins they may not have installed
   *  would be inventing their install. */
  | 'per-install'
  /** The one value that came out of no profile: the screenset UCCNC ships.
   *  A profile's own `mainscreenfilename` names a screenset file on that
   *  machine, so carrying one would point a different install at a screenset
   *  it does not have. */
  | 'uccnc-shipped'

export interface StateSection {
  section: string
  basis: StateBasis
  keys: readonly (readonly [string, string])[]
}

/** UCCNC's tool table is tool 0 plus 96 pockets, each with a Z offset and a
 *  diameter. */
const TOOL_SLOTS = 97
/** UCCNC binds 96 actions, each to a keyboard code and a screen-button code.
 *  `0` is the code for "nothing bound". */
const HOTKEY_SLOTS = 96
/** The six coordinates a work offset, a machine position and the statistics
 *  counters are all written per-axis in. */
const COORD_AXES = ['X', 'Y', 'Z', 'A', 'B', 'C'] as const
const WORK_OFFSET_GROUPS = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'] as const

type StateKeys = readonly (readonly [string, string])[]

/** `Stem0..Stem(n-1)`, all zero - the shape UCCNC writes a table in. */
const numbered = (stem: string, count: number): StateKeys =>
  Array.from({ length: count }, (_, i) => [`${stem}${i}`, '0'] as const)

/** UCCNC writes the hotkey table interleaved and one-based - `Keycode1`,
 *  `Buttoncode1`, `Keycode2`... - and every code is `0` when nothing is
 *  bound, which is what a profile this software wrote states. */
const unboundHotkeys = (): StateKeys =>
  Array.from({ length: HOTKEY_SLOTS }, (_, i) =>
    [[`Keycode${i + 1}`, '0'] as const, [`Buttoncode${i + 1}`, '0'] as const]).flat()

const zeroed = (names: readonly string[]): StateKeys =>
  names.map((name) => [name, '0'] as const)

const UCCNC_APPEARANCE: readonly (readonly [string, string])[] = [
  ['2DTLCmarker', 'True'],
  ['Viewerundonepathcolor', '3381759'],
  ['Viewerdonepathcolor', '-5374161'],
  ['Viewerrapidpathcolor', '16711680'],
  ['ViewerTCPmarkercolor', '16776960'],
  ['ViewerBackgroundcolor', '0'],
  ['Viewerboundariescolor', '16777215'],
  ['GVgcodecolors', '16777215'],
  ['GVmcodecolors', '-233'],
  ['GVscodecolors', '-32513'],
  ['GVfcodecolors', '-21931'],
  ['GVbackgroundcolor', '-12698050'],
  ['GVactualcodecolor', '-16777216'],
  ['GVactualcodemidlinescolor', '-16777216'],
  ['GVnotinterpretedcodecolor', '16711680'],
  ['GVaxiswordcolor', '-8323328'],
  ['GVcoordinatecolor', '-9250052'],
  ['TCPcone', 'True'],
  ['TCPcross', 'False'],
  ['RotateTCPwithplaneselection', 'True'],
  ['Showzeromark', 'True'],
  ['Zeromarkcolor', '-16711681'],
  ['DROwarningcolor', '-65536'],
  ['rotationpointmarkcolor', '-65536'],
  ['Showrotationmark', 'True'],
  ['Showtoolpathboundaries', 'True'],
  ['Highlightcolor', '-1'],
  ['radiusoffsetpathcolor', '-13675'],
  ['checkboxfillcolor', '-4144960'],
  ['Showmessageonsoftlimits', 'True'],
  ['ValidateTextfieldsonEnteronly', 'True'],
  ['Disablejogpanelautopopup', 'False'],
  ['Showtoolpathdimensions', 'True'],
  ['ShowRcompanalysisonfileload', 'True'],
  ['Disablevirtualmousemode', 'False'],
  ['Disabletoolpathview', 'False'],
  ['ShowtoolpathZzeroplate', 'False'],
  ['ZplateXstart', '0'],
  ['ZplateYstart', '0'],
  ['ZplateXextents', '100'],
  ['ZplateYextents', '100'],
  ['ZplateZposition', '0'],
  ['ZplateZpositiononbottom', 'False'],
  ['ZplatePlateOpacity', '25'],
  ['ZplateColor', '-65536'],
  ['ZplateXgrid', '10'],
  ['ZplateYgrid', '10'],
  ['ZplateGridOpacity', '25'],
  ['ZplateGridColor', '-1'],
  ['ZplateShowSoftlimits', 'False'],
  ['ZplateSoftlimitsColor', '-16711936'],
  ['ZplateSoftlimitsOpacity', '100'],
  ['Savetooltableonclosing', 'False'],
  ['Dontresettoolpathviewonreload', 'False'],
  ['Dontcompressimages', 'True'],
  ['tooldimscolor', '-1'],
  ['tooldimsaxiscolor', 'True'],
]

const UCCNC_CAM: readonly (readonly [string, string])[] = [
  ['Tooldia', '6'],
  ['Startdepth', '0'],
  ['Cutdepth', '-1'],
  ['Cutperpass', '1'],
  ['SafeZ', '25'],
  ['Feedrate', '1000'],
  ['Tooloverlap', '50'],
  ['Plungerate', '400'],
  ['Spindlespeed', '5000'],
  ['Arctolerance', '0.01'],
]

const UCCNC_SYSTEM_MESSAGES: readonly string[] = [
  'Valid license key was not found! Application will run in demo mode!',
  'Firmware update done!',
  'No UC100 connection was found! Application will run in demo mode!',
  'Firmware update in progress! Please wait and do not close the application...',
  'The application lost the connection with the motion controller device. [nl] Check the connection. The application is closing now! [nl] Save offsets?',
  'A machine axis position software limit was reached. The axis was now stopped.',
  'The reset logic of the software is active! [nl] Remove the reset condition with pressing the blinking reset button on the screen. [nl] If the reset condition cannot be removed can be due to an external e-stop button is pressed in or a limit switch on the machine tool is active. [nl] Please check the Diagnostics page for the input signals condition.',
  'The current job workspace is out of the set software limits.[nl] Adjust the softlimits to fit the job extents or disable the softlimits.',
  'The axis is disabled. To calibrate this axis enable the axis first.',
  'An internal error occured. The application is closing now.',
  'Enter a valid distance in absolute value!',
  'The calculated steps per value was saved.',
  'Please enter valid data.',
  'Active fixture:',
  'Are you sure you want to close?',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  'The Default profile cannot be deleted!',
  'File error.Could not delete the profile\'s macro library!',
  'Do you really want to delete the profile :',
  'File error.Could not copy default macros to profile!',
  'was loaded!',
  'The axis calibration makes a measurement to calibrate the steps per units resolution value for the machine axis. To abort and close this window press the cancel button.',
  'Mark the current position of the machine axis. Set the distance and the feedrate on this page and press the OK button to make a movement.',
  'Measure the travel distance on the machine axis from the previously marked point to the current point. Type the measured value to the field below and press OK.',
  'The new steps per value was calculated and written to the below field. To save the new value press OK. The process is then finished.',
  'Switch spindle on first',
  'Move Z-axis first to safeZ height:',
  'Make movement with safeZ to:',
  'Start position(Units):',
  'Actual steps per Unit:',
  'Distance to move(Units):',
  'Feed rate(Units/min):',
  'Distance measured(Units):',
  'Steps per Units calculated value:',
  'The software limits is lower than the safeZ height. Execute the command anyways?',
  'was created!',
]

const UCCNC_STATISTIC_COUNTERS: readonly string[] = [
  'TotalM3s', 'TotalM4s', 'TotalM7s', 'TotalM8s', 'Totaltimedays', 'Totaltimehours',
  'Totaltimeminutes', 'Totaltimeseconds', 'M3timedays', 'M3timehours', 'M3timeminutes',
  'M3timeseconds', 'M4timedays', 'M4timehours', 'M4timeminutes', 'M4timeseconds',
  'Cyclestimedays', 'Cyclestimehours', 'Cyclestimeminutes', 'Cyclestimeseconds',
  'TotaldistX', 'TotalcutX', 'TotaldistY', 'TotalcutY', 'TotaldistZ', 'TotalcutZ',
  'TotaldistA', 'TotalcutA', 'TotaldistB', 'TotalcutB', 'TotaldistC', 'TotalcutC',
]

/**
 * THE BASELINE, SECTION BY SECTION. Order is UCCNC's own.
 *
 * `Statistics` ends with two keys that name something OTHER than runtime
 * noise. `Softwareversion` names the WRITER: this software is not a build of
 * UCCNC, so it is emitted EMPTY - present, typed as the text it is, and
 * stating nothing false. `UCdevicetype` names the MACHINE (WO-1805): the
 * baseline's empty value is what a machine that has stated no board writes,
 * and `boardIdentityForExport` replaces it with the DeviceInfo type the
 * machine DOES state. It is never a guessed 19, never a BoardID, never a
 * board read from the machine's name or from the exporting app.
 */
export const STATE_BASELINE: readonly StateSection[] = [
  {
    section: 'Tooltablevalues',
    basis: 'unrun',
    keys: [...numbered('TooloffsetZ', TOOL_SLOTS), ...numbered('ToolDia', TOOL_SLOTS)],
  },
  ...WORK_OFFSET_GROUPS.map((group): StateSection => ({
    section: `Workoffset_${group}`,
    basis: 'unrun',
    keys: zeroed(COORD_AXES.map((axis) => `Workoffset${axis}`)),
  })),
  {
    section: 'Machinecoords',
    basis: 'unrun',
    keys: zeroed(COORD_AXES.map((axis) => `Machinecoords${axis}`)),
  },
  { section: 'Tooloffsetcoords', basis: 'unrun', keys: [['TooloffsetZ', '0']] },
  {
    section: 'Statistics',
    basis: 'unrun',
    keys: [
      ...zeroed(UCCNC_STATISTIC_COUNTERS),
      ['UCdevicetype', ''],
      ['Softwareversion', ''],
    ],
  },
  {
    section: 'Screensetsettings',
    basis: 'uccnc-shipped',
    keys: [['mainscreenfilename', 'Default'], ['splashscreen', '0']],
  },
  { section: 'Appearancesetupsettings', basis: 'uccnc-written', keys: UCCNC_APPEARANCE },
  {
    section: 'Hotkeysettings',
    basis: 'unrun',
    keys: unboundHotkeys(),
  },
  {
    section: 'Systemmessages',
    basis: 'uccnc-written',
    keys: UCCNC_SYSTEM_MESSAGES.map((text, i) => [`Message${i}`, text] as const),
  },
  { section: 'CAMsettings', basis: 'uccnc-written', keys: UCCNC_CAM },
  { section: 'Plugins_enabled', basis: 'per-install', keys: [] },
  { section: 'Plugins_callstartup', basis: 'per-install', keys: [] },
]

/** The names alone - what `measureProfileGap` needs to know a section is
 *  accounted for rather than unclassified. */
const STATE_SECTION_NAMES: readonly string[] = STATE_BASELINE.map((s) => s.section)

/** The catalogue's own sections, in catalogue order - the machine
 *  configuration, and the only thing the gap count is about. */
export const CONFIG_SECTION_NAMES: readonly string[] = (() => {
  const seen: string[] = []
  for (const field of UCCNC_SETTING_FIELDS) {
    if (!seen.includes(field.group)) seen.push(field.group)
  }
  return seen
})()

/** `Generalsettings.Profilename` is UCCNC's name for the profile, and it lives
 *  on `MachineConfig.name` - one level ABOVE the controller definition. It is
 *  the catalogue's one identity key, so it is emitted from the name the caller
 *  hands in rather than from the definition, which does not have it. */
const IDENTITY_OWNER = 'MachineConfig.name'

/** Why a key this software models is not in the emitted file. */
export type ProfileAbsenceReason =
  /** The definition holds nothing this machine stated for the key. For a
   *  hand-built definition that is every key: `stated` and `settings` are both
   *  empty until something records what the user typed (WO-1039). */
  | 'not-stated'
  /** The definition holds a value and it cannot be written in UCCNC's terms -
   *  a polarity nobody has given, an enable delay that is not a whole number
   *  of UCCNC's 10 ms steps. Reported, never rounded into place. */
  | 'unrepresentable'
  /** `Generalsettings.Profilename`, when no name was handed in. */
  | 'no-identity'

export interface ProfileAbsence {
  /** `axessettingscontrolX.Velocity`, in the catalogue's spelling. */
  key: string
  reason: ProfileAbsenceReason
  /** One line a person can act on. */
  detail: string
}

export interface ProfileExportResult {
  /** The `.pro` text. CRLF, `[Section]` then `Key=Value`, no blank lines. */
  text: string
  /** Catalogue keys this definition gave back, in the catalogue's spelling. */
  emitted: string[]
  /** Every catalogue key it did not, NAMED. Never a bare count. */
  absent: ProfileAbsence[]
  /**
   * The runtime-state and application-preference keys the file also carries,
   * `Section.Key`. NOT part of `emitted` and NOT part of any gap - ADR-0044
   * Amendment 1 puts them outside the completeness bar. Reported so the count
   * is visible rather than implied: a file that grew 633 lines should say so.
   */
  stateKeys: string[]
}

export interface ProfileExportOptions {
  /** What to write into `Generalsettings.Profilename`. Comes from
   *  `MachineConfig.name`; absent means the key is absent and reported. */
  profileName?: string | null
  /** THE MACHINE'S CURRENT DECLARED BOARD (WO-1805). Like `profileName` this
   *  is a fact one level ABOVE the definition - it lives on
   *  `MachineConfig.controllerBoard` - so a caller that holds the machine hands
   *  it in. HOW the field is set decides what it means, and the two cases are
   *  NOT the same (WO-1805, "Complete the actual export buttons"):
   *
   *    - OMITTED (the key is not on the options object at all): a genuinely
   *      definition-only caller - the gauge or a hand-built export. The identity
   *      the imported profile itself stated carries the line, so a definition
   *      that was told what board it describes does not lose that identity.
   *      A caller holding a complete `MachineConfig` must never omit this option;
   *      an absent optional field on that record is its current "not stated".
   *    - PRESENT with a positive `deviceType`: the current declared fact ships
   *      and beats any archived row - an edit made after import is the truth.
   *    - PRESENT as `null`/`undefined` (the key is named, the value is empty):
   *      an EXPLICIT clear. The operator said this machine declares no board, so
   *      the line goes out empty - it must NOT resurrect a stale archived row.
   *
   *  Never a guessed 19, never a BoardID, never a board read from the machine's
   *  name or from this app. */
  controllerBoard?: MachineControllerBoard | null
}

/** Walk `axes[X].stepPin.port` / `homing.perAxis[X].backOff` / `io.estop.pin`.
 *  `axes` is an ARRAY keyed by axis name, which is the one step a plain
 *  property walk cannot take. */
function held(definition: ControllerDefinition, path: string): unknown {
  let current: unknown = definition
  for (const token of path.replace(/\[([^\]]+)\]/g, '.$1').split('.')) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      current = current.find((entry) => (entry as { axis?: AxisName }).axis === token)
    } else {
      current = (current as Record<string, unknown>)[token]
    }
  }
  return current
}

type Held =
  | { ok: true; value: ControllerSettingValue }
  | { ok: false; reason: ProfileAbsenceReason; detail: string }

const unrepresentable = (detail: string): Held =>
  ({ ok: false, reason: 'unrepresentable', detail })

/**
 * READ ONE NAMED FIELD BACK IN UCCNC'S TERMS.
 *
 * The importer's conversions are inverted here and NOWHERE ELSE, so the two
 * ends of the round trip have one place each to be wrong in:
 *
 *   - `Enabledelay` IS THE 10x TRAP (see the importer's header). UCCNC counts
 *     10 ms steps; `enableDelayMs` is milliseconds. A delay that is not a
 *     whole number of steps is REPORTED rather than rounded - rounding it
 *     would hand the drive a different delay than the definition states.
 *   - `Slaveaxis` is an axis NAME or the literal `None`. `null` means no
 *     slave, which is what `None` says.
 *   - `Homedirectionpositive` is a boolean; the definition holds the word.
 */
function heldValue(definition: ControllerDefinition, field: ControllerSettingField): Held {
  const path = field.ownedBy ?? ''

  // Six keys, one list. Slot n reads back as the axis at position n, or the
  // literal `None` past the end - the same rule the importer states a slot by.
  if (path === 'homing.order') {
    const slot = Number(field.key.replace(/^.*Homesequence/, ''))
    const order = definition.homing.order
    const written: string = slot >= 1 && slot <= order.length ? order[slot - 1] : 'None'
    return { ok: true, value: { kind: 'enum', value: written } }
  }

  const raw = held(definition, path)
  const shape = path.replace(/\[[XYZABC]\]/g, '[#]')

  // `null` IS AN ANSWER HERE, and only here. `slaveAxis: null` means NO SLAVE
  // on this axis, which is exactly what UCCNC's literal `None` says - so it is
  // read before the absence guard below rather than reported as a hole. Every
  // other `null` in a named field is genuine absence: an unknown polarity is
  // not a `False` (WO-995), and inventing one is how an e-stop gets inverted.
  if (shape === 'axes[#].slaveAxis') {
    return { ok: true, value: { kind: 'enum', value: typeof raw === 'string' ? raw : 'None' } }
  }

  if (raw === null || raw === undefined) {
    return unrepresentable(`${path} holds no value - nobody has told this software the `
      + 'polarity or the number, and a substituted one would be a machine fact nobody chose')
  }

  if (shape === 'axes[#].enableDelayMs') {
    if (typeof raw !== 'number' || raw % 10 !== 0) {
      return unrepresentable(`${path} is ${String(raw)} ms, which is not a whole number of `
        + "UCCNC's 10 ms steps")
    }
    return { ok: true, value: { kind: 'number', value: raw / 10 } }
  }
  if (shape === 'homing.perAxis[#].direction') {
    return { ok: true, value: { kind: 'boolean', value: raw === 'positive' } }
  }

  if (field.kind === 'number' && typeof raw === 'number' && Number.isFinite(raw)) {
    return { ok: true, value: { kind: 'number', value: raw } }
  }
  if (field.kind === 'boolean' && typeof raw === 'boolean') {
    return { ok: true, value: { kind: 'boolean', value: raw } }
  }
  if ((field.kind === 'text' || field.kind === 'enum') && typeof raw === 'string') {
    return { ok: true, value: { kind: field.kind, value: raw } }
  }
  return unrepresentable(`${path} holds ${typeof raw}, which is not the ${field.kind} `
    + `UCCNC writes at ${field.key}`)
}

/** The key's own spelling, without its section - `[Generalsettings]` and
 *  `Softlimitsenable` are written on different lines. */
const bareKey = (field: ControllerSettingField): string =>
  field.key.slice(field.group.length + 1)

/** One line of INI. A CR or LF inside a key or value would start a new line
 *  the loader reads as a section or key that came from nowhere - a machine
 *  name imported from JSON can carry one. Refuse loudly, never sanitise. */
const iniLine = (key: string, value: string): string => {
  if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
    throw new Error(`cannot write '${key}' to a .pro: the value contains a line break`)
  }
  return `${key}=${value}`
}

/** The ONE key of the runtime-state block that names a machine fact rather
 *  than runtime noise, and so is not static (WO-1805). */
const BOARD_IDENTITY_SECTION = 'Statistics'
const BOARD_IDENTITY_KEY = 'UCdevicetype'

/**
 * THE BOARD LINE, IN UCCNC'S OWN TERMS: a positive DeviceInfo type, or the
 * empty value this block uses when nothing states a board.
 *
 * PRIORITY, because two carriers of one fact must not disagree (WO-1805). The
 * FIRST question is whether the caller NAMED the field at all, and it is asked
 * with `in`, not by reading the value - because a live caller that states the
 * machine's current identity as "nothing" (an explicit clear) must be heard,
 * and it is not the same thing as a definition-only caller that never mentioned
 * a board:
 *
 *   1. `options.controllerBoard` NAMED - the machine's CURRENT identity, the one
 *      the Controller area edits. A positive DeviceInfo type ships and beats the
 *      archived row, so an edit made after import is what exports. A named
 *      `null`/`undefined` is an EXPLICIT CLEAR and ships the empty value: it
 *      must NOT fall through to the archived row, because the operator just said
 *      this machine is not that board.
 *   2. `options.controllerBoard` OMITTED - a definition-only caller. The
 *      `Statistics.UCdevicetype` row the imported profile itself stated, carried
 *      in `profileOnlySettings`, fills the line. A machine that was told what
 *      board it is does not lose that identity by passing through an export; the
 *      exported machine is not the exporting application.
 *   3. nothing stated on either carrier -> the empty baseline value, the existing
 *      honest missing-value convention for this block. Never a guessed 19, never
 *      a BoardID, never a board read from the machine's name or from this app.
 *
 * Both carriers resolve through the shared identity helpers - the one name
 * table in `controllerBoard.ts`, the same two rules the importer decodes
 * with - and come out NUMERIC, so an unknown-but-positive type is preserved
 * verbatim and no parallel name map exists. A name the table does not know
 * is not an identity: it falls to the empty value, which the importer
 * reports honestly rather than swallowing.
 */
function boardIdentityForExport(
  definition: ControllerDefinition | null | undefined,
  options: ProfileExportOptions,
): string {
  // The field was NAMED: the caller is stating the machine's present identity,
  // and that statement owns the line outright - including "none" (null or
  // undefined), which is an explicit clear and must not resurrect the archive.
  if ('controllerBoard' in options) {
    const declared = options.controllerBoard?.deviceType
    return Number.isInteger(declared) && (declared as number) >= 1 ? String(declared) : ''
  }

  // The field was OMITTED: a definition-only caller. The identity the profile
  // itself stated carries the line.
  const row = uccncProfileOnlySettings(definition).find(
    (setting) => setting.section.toLowerCase() === BOARD_IDENTITY_SECTION.toLowerCase()
      && setting.key.toLowerCase() === BOARD_IDENTITY_KEY.toLowerCase(),
  )
  const value = (row?.value ?? '').trim()
  const numeric = Number(value)
  if (value !== '' && Number.isInteger(numeric) && numeric >= 1) return String(numeric)
  // UCCNC's legacy profile spelling for the vendor name AXBB-E - the same
  // alias the importer applies, then the one reverse lookup of the table.
  const named = uccncBoardDeviceTypeByName(/^AXBB$/i.test(value) ? 'AXBB-E' : value)
  return named !== null ? String(named) : ''
}

/**
 * WHAT THIS DEFINITION CAN GIVE BACK, AND WHAT IT CANNOT.
 *
 * The whole rule in one sentence: a key is emitted when this definition STATES
 * it, and `definitionStatesKey` is the one place that question is answered.
 * A value in `settings` states itself by being there; a value in a named field
 * (`axes`, `homing`, `io`) states itself through the provenance the importer
 * recorded.
 *
 * THAT SECOND HALF IS WHY A HAND-BUILT DEFINITION EMITS NOTHING TODAY, and it
 * is this order's FINDING rather than a defect in it. `axes[X].maxVelocity` is
 * `6000` on a blank definition because `createDefaultAxisDefinition` put it
 * there - not because anybody said so. `ControllerDefinition.stated` records
 * that difference and is EMPTY for a machine somebody is building by hand:
 * *"the fields are populated, their provenance is not"* (types/index.ts). So
 * the gauge reads a full-width gap against Operator's profile and every one of
 * them says `not-stated`. WO-1039 - the editor that writes a user's value into
 * `settings`, where presence IS the statement - is what moves that number, and
 * it moves monotonically because nothing here can be satisfied by a default.
 */
export function exportUccncProfile(
  definition: ControllerDefinition | null | undefined,
  options: ProfileExportOptions = {},
): ProfileExportResult {
  const emitted: string[] = []
  const absent: ProfileAbsence[] = []
  const lines: string[] = []

  const profileName = options.profileName ?? null

  for (const section of CONFIG_SECTION_NAMES) {
    lines.push(`[${section}]`)
    for (const field of UCCNC_SETTING_FIELDS) {
      if (field.group !== section) continue

      // THE ONE IDENTITY KEY. It is not on the definition and never will be -
      // a definition that "stated" it would be claiming a field it does not
      // have - so it comes from the machine's name or it is reported absent.
      if (field.ownedBy === IDENTITY_OWNER) {
        if (profileName === null || profileName === '') {
          absent.push({
            key: field.key,
            reason: 'no-identity',
            detail: 'this profile has no name - MachineConfig.name carries it, none was given',
          })
          continue
        }
        lines.push(iniLine(bareKey(field), profileName))
        emitted.push(field.key)
        continue
      }

      if (!definition || !definitionStatesKey(definition, 'uccnc', field.key)) {
        absent.push({
          key: field.key,
          reason: 'not-stated',
          detail: field.ownedBy === null
            ? 'no value in ControllerDefinition.settings - this definition has not stated it'
            : `${field.ownedBy} holds a value, but nothing recorded that this machine chose `
              + 'it, so writing it back would invent a machine fact',
        })
        continue
      }

      // `settings` IS ASKED FIRST, INCLUDING FOR A KEY THE CATALOGUE SAYS A
      // NAMED FIELD OWNS - because `ownedBy` names where the value USUALLY
      // lives, and a reader is allowed to hand it back. `readPin` does exactly
      // that: a wire whose port is 7 beside a pin of 0 collapses to
      // unassigned, so the port and its negate key are RELEASED to
      // `collectSettings` and the machine's own number is carried there
      // instead. Reading the named field for those keys reported 27 holes in a
      // profile that has none. A value lives in exactly one place; this asks
      // both places in the order that finds it.
      const stored = controllerSettingValue(definition.settings, 'uccnc', field.key)
      const resolved: Held = stored !== null
        ? { ok: true, value: stored }
        : field.ownedBy === null
          ? unrepresentable('provenance says this key is stated but settings holds no value')
          : heldValue(definition, field)

      if (!resolved.ok) {
        absent.push({ key: field.key, reason: resolved.reason, detail: resolved.detail })
        continue
      }
      lines.push(iniLine(bareKey(field), formatUccncSettingValue(resolved.value)))
      emitted.push(field.key)
    }
  }

  // THE STATE AND PREFERENCE BLOCK - emitted in full, counted in nothing. It
  // goes into `stateKeys` and NEVER into `emitted`, which is what keeps the
  // gap honest: 633 lines of tool table and appearance cannot flatter a
  // measurement of the 1680 machine-configuration keys.
  const stateKeys: string[] = []
  for (const { section, keys } of STATE_BASELINE) {
    lines.push(`[${section}]`)
    for (const [key, value] of keys) {
      // The one machine fact in this block (WO-1805): the declared board
      // rides out as the DeviceInfo type the machine states, never the
      // empty baseline. Every other key stays the static baseline, and
      // NOTHING here enters `emitted` - the board line cannot flatter the
      // gap any more than the tool table can.
      const written = section === BOARD_IDENTITY_SECTION && key === BOARD_IDENTITY_KEY
        ? boardIdentityForExport(definition, options)
        : value
      lines.push(iniLine(key, written))
      stateKeys.push(`${section}.${key}`)
    }
  }

  return { text: lines.join(EOL) + EOL, emitted, absent, stateKeys }
}

// --- THE GAUGE ------------------------------------------------------------

/** How a machine-configuration key in somebody else's profile fares against
 *  ours. Four answers, and they are four different pieces of work. */
export type ProfileGapKind =
  /** Our catalogue has no entry for the key. The model cannot even name it,
   *  which is the deepest gap there is. */
  | 'unmodelled'
  /** Modelled, and a named field (`axes`/`homing`/`io`) owns it - this
   *  software already presents and edits it. Only its provenance is missing. */
  | 'named-field-unstated'
  /** Modelled, and its value would live in `ControllerDefinition.settings`,
   *  which a hand-built definition leaves empty. */
  | 'settings-unstated'
  /** Modelled, held, and it could not be written in UCCNC's terms. */
  | 'unrepresentable'

export interface ProfileGap {
  key: string
  kind: ProfileGapKind
  detail: string
}

export interface ProfileGapReport {
  /** The profile this was measured against. */
  profileLabel: string
  /** Machine-configuration keys in THEIR profile. The denominator. */
  theirConfigKeys: number
  /** How many of those our export carried a value for. */
  covered: number
  /**
   * THE NUMBER THIS ORDER PUBLISHES. `theirConfigKeys - covered`, and the
   * target is zero. Published even when it is not - a partial number is honest
   * and monotonic; silence is not.
   */
  gapCount: number
  /** Every gap, NAMED. */
  gaps: ProfileGap[]
  /** Gap counts by kind, so the headline says what the WORK is. */
  byKind: Record<ProfileGapKind, number>
  /**
   * Sections in their profile this software classifies as neither machine
   * configuration nor known runtime-state / application-preference. Reported
   * rather than dropped: a section quietly excluded is a gap that never
   * reaches the count.
   */
  unclassifiedSections: string[]
  /** Keys our export carries that their profile does not. Our definition may
   *  hold MORE than a `.pro` states (ADR-0044 requirement 3), so this is
   *  information, not a fault. */
  extraKeys: string[]
}

/** `.pro` is INI-shaped. This reads only what the gauge needs - section, key -
 *  and keeps the file's own spelling, so a report names what a person can grep
 *  for. */
export function parseProfileKeys(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>()
  let current: string[] | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1)
      current = sections.get(name) ?? []
      sections.set(name, current)
    } else if (current && line.includes('=')) {
      current.push(line.slice(0, line.indexOf('=')))
    }
  }
  return sections
}

const lower = (value: string): string => value.toLowerCase()

/**
 * MEASURE THIS DEFINITION AGAINST A UCCNC-AUTHORED PROFILE.
 *
 * *"Report every machine-configuration key present in theirs and absent or
 * unrepresentable in ours. That count is the number this order publishes, and
 * the target is zero."*
 *
 * WHAT ZERO WOULD MEAN, and it is smaller than it sounds (ADR-0044, "THE GAUGE
 * HAS A BLIND SPOT"): zero means our definition can EXPRESS everything a
 * `.pro` expresses. It does NOT mean we are a UCCNC replacement. Some UCCNC
 * capabilities are delivered by PLUGINS - Operator's Modbus spindle is 72 keys we
 * would count as covered describing a spindle we still could not turn. Anyone
 * quoting this number must say which of the two it is.
 */
export function measureProfileGap(
  theirText: string,
  definition: ControllerDefinition | null | undefined,
  options: ProfileExportOptions & { profileLabel?: string } = {},
): ProfileGapReport {
  const exported = exportUccncProfile(definition, options)
  const oursByKey = new Set(exported.emitted.map(lower))
  const absentByKey = new Map(exported.absent.map((entry) => [lower(entry.key), entry]))
  const configSections = new Set(CONFIG_SECTION_NAMES.map(lower))
  const knownOther = new Set(STATE_SECTION_NAMES.map(lower))

  const gaps: ProfileGap[] = []
  const unclassifiedSections: string[] = []
  const theirKeys = new Set<string>()
  let theirConfigKeys = 0
  let covered = 0

  for (const [section, keys] of parseProfileKeys(theirText)) {
    if (!configSections.has(lower(section))) {
      if (!knownOther.has(lower(section))) unclassifiedSections.push(section)
      continue
    }
    for (const key of keys) {
      const full = `${section}.${key}`
      theirConfigKeys++
      theirKeys.add(lower(full))
      if (oursByKey.has(lower(full))) {
        covered++
        continue
      }

      const field = uccncSettingField(full)
      const absence = absentByKey.get(lower(full))
      const kind: ProfileGapKind = field === undefined
        ? 'unmodelled'
        : absence?.reason === 'unrepresentable'
          ? 'unrepresentable'
          : field.ownedBy !== null
            ? 'named-field-unstated'
            : 'settings-unstated'
      gaps.push({
        key: full,
        kind,
        detail: absence?.detail
          ?? 'this software has no catalogue entry for the key - it cannot say what it means, '
            + 'what unit it is in or what it will accept',
      })
    }
  }

  const byKind: Record<ProfileGapKind, number> = {
    unmodelled: 0, 'named-field-unstated': 0, 'settings-unstated': 0, unrepresentable: 0,
  }
  for (const gap of gaps) byKind[gap.kind]++

  return {
    profileLabel: options.profileLabel ?? 'the reference profile',
    theirConfigKeys,
    covered,
    gapCount: gaps.length,
    gaps,
    byKind,
    unclassifiedSections,
    extraKeys: exported.emitted.filter((key) => !theirKeys.has(lower(key))),
  }
}

/** The gap report as the lines a person reads. The number always comes with
 *  what it MEANS - a measure quoted without its meaning is how "100% VISIBLE"
 *  got reported as done (ADR-0044). */
export function formatProfileGap(report: ProfileGapReport): string {
  const out = [
    `UCCNC .pro EXPORT GAP - measured against ${report.profileLabel}`,
    '='.repeat(72),
    `machine-configuration keys in that profile : ${report.theirConfigKeys}`,
    `carried by our export                      : ${report.covered}`,
    `GAP                                        : ${report.gapCount}   (target 0)`,
    '',
    'ZERO WOULD MEAN "our definition can express everything a .pro expresses",',
    'and nothing more. It would NOT mean we are a UCCNC replacement: some UCCNC',
    'capabilities are delivered by plugins, not by profile fields (ADR-0044).',
    '',
    'THE GAP BY KIND - four different pieces of work',
    '-'.repeat(72),
  ]
  const labels: Record<ProfileGapKind, string> = {
    unmodelled: 'no catalogue entry at all - the model cannot name the key',
    'named-field-unstated': 'a named field owns it; only its provenance is missing',
    'settings-unstated': 'would live in ControllerDefinition.settings, which is empty',
    unrepresentable: "held, and not writable in UCCNC's terms",
  }
  for (const kind of Object.keys(labels) as ProfileGapKind[]) {
    out.push(`${String(report.byKind[kind]).padStart(6)}  ${kind.padEnd(22)} ${labels[kind]}`)
  }
  if (report.unclassifiedSections.length > 0) {
    out.push('', 'UNCLASSIFIED SECTIONS - classify these before trusting the totals',
      ...report.unclassifiedSections.map((name) => `   ${name}`))
  }
  if (report.extraKeys.length > 0) {
    out.push('', `OURS AND NOT THEIRS - ${report.extraKeys.length} keys. Our definition may hold `
      + 'more than a .pro', 'states (ADR-0044 requirement 3); this is information, not a fault.')
  }
  return out.join('\n') + '\n'
}
