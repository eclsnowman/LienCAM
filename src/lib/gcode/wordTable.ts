// ============================================================
// WO-1644 - ONE G-CODE WORD TABLE PER DIALECT
// ============================================================
// Which G and M words a dialect accepts, the category and modal group each
// belongs to, and what each does. Every route that decides whether a word runs
// reads THIS: the shared reader (loaded programs and typed motion lines), the
// typed MDI line, the app-command translator, the preview, the linter's motion
// words, the simulator and the GRBL modal report. None of them keeps a list of
// its own.
//
// Every "not supported" sentence is generated here from the same table, so it
// can never name a word that runs, or leave out one that does.
//
// A dialect differs from another only in its data: its label, the M-code
// range its controller runs as user macros, and GRBL's and LinuxCNC's further
// probe forms G38.3-G38.5. (G43.1 is in every table: the app translates it
// into its own tool length offset call on every controller.)
// ============================================================

export type GcodeTableDialect = 'uccnc' | 'grbl' | 'linuxcnc' | 'generic'

export type GcodeWordCategory =
  | 'motion'
  | 'canned cycle'
  | 'dwell'
  | 'plane'
  | 'units'
  | 'cutter compensation'
  | 'tool length offset'
  | 'work offset'
  | 'offset write'
  | 'machine frame'
  | 'home'
  | 'reference point'
  | 'probe'
  | 'path control'
  | 'distance mode'
  | 'arc-centre mode'
  | 'feed-rate mode'
  | 'canned-cycle return'
  | 'program flow'
  | 'spindle'
  | 'tool change'
  | 'coolant'
  /** WO-1650: a word the MACHINE DEFINITION points at one of its outputs - a
   *  pump on M10, air on M11. Learnt from the definition, never built in. */
  | 'output'

export interface GcodeWordEntry {
  /** Spelled as a file carries it: `G0`, `G90.1`, `M30`. */
  word: string
  letter: 'G' | 'M'
  value: number
  category: GcodeWordCategory
  /** Two words of one modal group on one block are two answers to one question.
   *  Null for a non-modal word (G4, G28, G53, G10). */
  modalGroup: string | null
  /** What the word does, completing "G0 ...". */
  meaning: string
}

export interface GcodeWordTable {
  dialect: GcodeTableDialect
  /** How the dialect is named in a sentence. */
  label: string
  entries: readonly GcodeWordEntry[]
  /** The M-code range this controller runs as user macros; null when it has none. */
  macroMCodes: { from: number; to: number | null } | null
  /** WO-1643: the M-codes one machine's macros are bound to - macro calls at
   *  any number, inside the range or not. Absent on a dialect's own table. */
  boundMacroMCodes?: readonly number[]
}

type Row = readonly [string, GcodeWordCategory, string | null, string]

const COMMON_ROWS: readonly Row[] = [
  ['G0', 'motion', 'motion', 'rapids to the named point'],
  ['G1', 'motion', 'motion', 'feeds in a straight line to the named point'],
  ['G2', 'motion', 'motion', 'feeds along a clockwise arc'],
  ['G3', 'motion', 'motion', 'feeds along a counter-clockwise arc'],
  ['G4', 'dwell', null, 'dwells for P'],
  ['G10', 'offset write', null, 'writes a work offset (L2 / L20)'],
  ['G17', 'plane', 'plane', 'selects the XY plane'],
  ['G18', 'plane', 'plane', 'selects the XZ plane'],
  ['G19', 'plane', 'plane', 'selects the YZ plane'],
  ['G20', 'units', 'units', 'reads the numbers that follow as inches'],
  ['G21', 'units', 'units', 'reads the numbers that follow as millimetres'],
  ['G28', 'home', null, 'rapids to the machine home position'],
  ['G30', 'reference point', null, 'rapids to a stored reference point'],
  ['G38.2', 'probe', null, 'probes toward the named point'],
  ['G40', 'cutter compensation', 'cutter compensation', 'cancels cutter compensation'],
  ['G43', 'tool length offset', 'tool length offset', 'applies the tool length offset named by H'],
  ['G43.1', 'tool length offset', 'tool length offset', 'applies the tool length offset given by Z'],
  ['G49', 'tool length offset', 'tool length offset', 'cancels the tool length offset'],
  ['G53', 'machine frame', null, 'reads this block\'s axis words in machine coordinates'],
  ['G54', 'work offset', 'work offset', 'selects work offset 1'],
  ['G55', 'work offset', 'work offset', 'selects work offset 2'],
  ['G56', 'work offset', 'work offset', 'selects work offset 3'],
  ['G57', 'work offset', 'work offset', 'selects work offset 4'],
  ['G58', 'work offset', 'work offset', 'selects work offset 5'],
  ['G59', 'work offset', 'work offset', 'selects work offset 6'],
  ['G61', 'path control', 'path control', 'stops exactly at each point'],
  ['G64', 'path control', 'path control', 'blends the path between points'],
  ['G80', 'canned cycle', 'motion', 'cancels the canned cycle'],
  ['G81', 'canned cycle', 'motion', 'drills to Z and retracts'],
  ['G82', 'canned cycle', 'motion', 'drills to Z, dwells for P and retracts'],
  ['G83', 'canned cycle', 'motion', 'peck-drills to Z by Q'],
  ['G90', 'distance mode', 'distance', 'reads axis words as absolute positions'],
  ['G90.1', 'arc-centre mode', 'arc-centre distance', 'reads arc centres as absolute positions'],
  ['G91', 'distance mode', 'distance', 'reads axis words as distances from where the tool is'],
  ['G91.1', 'arc-centre mode', 'arc-centre distance', 'reads arc centres relative to the arc start'],
  ['G93', 'feed-rate mode', 'feed rate', 'reads F as inverse time'],
  ['G94', 'feed-rate mode', 'feed rate', 'reads F as units per minute'],
  ['G98', 'canned-cycle return', 'canned-cycle return', 'returns a canned cycle to its starting Z'],
  ['G99', 'canned-cycle return', 'canned-cycle return', 'returns a canned cycle to its R plane'],
  ['M0', 'program flow', 'program flow', 'pauses the program'],
  ['M1', 'program flow', 'program flow', 'pauses the program if optional stop is on'],
  ['M2', 'program flow', 'program flow', 'ends the program'],
  ['M3', 'spindle', 'spindle', 'starts the spindle clockwise at S'],
  ['M4', 'spindle', 'spindle', 'starts the spindle counter-clockwise at S'],
  ['M5', 'spindle', 'spindle', 'stops the spindle'],
  ['M6', 'tool change', null, 'fits the tool named by T'],
  ['M7', 'coolant', 'coolant', 'turns mist coolant on'],
  ['M8', 'coolant', 'coolant', 'turns flood coolant on'],
  ['M9', 'coolant', 'coolant', 'turns all coolant off'],
  ['M30', 'program flow', 'program flow', 'ends the program'],
]

function entry([word, category, modalGroup, meaning]: Row): GcodeWordEntry {
  const letter = word[0] as 'G' | 'M'
  return { word, letter, value: Number(word.slice(1)), category, modalGroup, meaning }
}

function buildTable(
  dialect: GcodeTableDialect,
  label: string,
  rows: readonly Row[],
  macroMCodes: GcodeWordTable['macroMCodes'],
): GcodeWordTable {
  const entries = rows.map(entry).sort((a, b) => (a.letter === b.letter ? a.value - b.value : a.letter < b.letter ? -1 : 1))
  return { dialect, label, entries, macroMCodes }
}

/** GRBL's and LinuxCNC's further probe forms. */
const PROBE_FORM_ROWS: readonly Row[] = [
  ['G38.3', 'probe', null, 'probes toward the named point without an error on no contact'],
  ['G38.4', 'probe', null, 'probes away from the work until contact is lost'],
  ['G38.5', 'probe', null, 'probes away from the work, without an error on no loss of contact'],
]

const BUILT_IN: Record<GcodeTableDialect, GcodeWordTable> = {
  // UCCNC runs M-codes from 1000 up as user macro files (Fusion's UCCNC post
  // calls M2001). This is only the DEFAULT for a machine that states nothing:
  // the machine's own range and bound codes win (`gcodeWordTableForMachine`).
  uccnc: buildTable('uccnc', 'UCCNC', COMMON_ROWS, { from: 1000, to: null }),
  grbl: buildTable('grbl', 'GRBL', [...COMMON_ROWS, ...PROBE_FORM_ROWS], null),
  // LinuxCNC's user-defined M-codes are M100-M199.
  linuxcnc: buildTable('linuxcnc', 'LinuxCNC', [...COMMON_ROWS, ...PROBE_FORM_ROWS], { from: 100, to: 199 }),
  // The Generic post emits the shared plain RS-274 words and promises no
  // controller-specific probe forms or user-macro range.
  generic: buildTable('generic', 'Generic', COMMON_ROWS, null),
}

/** A user controller still enters the existing reader through one of its
 *  established dwell-unit dialects. The controller id selects the table; this
 *  base dialect only preserves the reader's P-unit arithmetic until that
 *  arithmetic is carried by the table itself. */
const registeredControllers = new Map<string, GcodeWordTable>()

/** The table selected by the current machine for each reader dialect. A direct
 *  built-in selection clears every prior user selection, so a table carried by
 *  the previous machine cannot leak through a different dialect route. */
let selected: Partial<Record<GcodeTableDialect, GcodeWordTable>> = {}
let selectedController: Partial<Record<GcodeTableDialect, string>> = {}

/** Test/diagnostic overrides remain the outermost layer, preserving the public
 *  useGcodeWordTable contract while controller selection changes underneath. */
let overrides: Partial<Record<GcodeTableDialect, GcodeWordTable>> = {}

/** The table a dialect ships with, whatever table is in force. A word in it is
 *  a standard word of the dialect; a word outside it that a machine definition
 *  points at an output is that machine's own. */
export function builtInGcodeWordTable(dialect: GcodeTableDialect): GcodeWordTable {
  return BUILT_IN[dialect]
}

/** Plain RS-274 words for a user post that did not bring a narrower table.
 *  The caller supplies the existing reader dialect whose dwell arithmetic
 *  matches the post (`uccnc` for milliseconds, otherwise `grbl`). */
export function genericGcodeWordTable(
  label: string,
  dialect: GcodeTableDialect = 'grbl',
): GcodeWordTable {
  return buildTable(dialect, label, COMMON_ROWS, null)
}

/** Make one user-owned controller id resolve to the word table it carries. */
export function registerGcodeWordTable(controllerId: string, table: GcodeWordTable): void {
  registeredControllers.set(controllerId, table)
  if (selectedController[table.dialect] === controllerId) {
    selected = { ...selected, [table.dialect]: table }
  }
}

/** Remove a user-owned controller table without disturbing any other id. */
export function unregisterGcodeWordTable(controllerId: string): void {
  const table = registeredControllers.get(controllerId)
  registeredControllers.delete(controllerId)
  if (table && selectedController[table.dialect] === controllerId) {
    const next = { ...selected }
    delete next[table.dialect]
    selected = next
    const nextController = { ...selectedController }
    delete nextController[table.dialect]
    selectedController = nextController
  }
}

/** The dialect a machine's declared controller speaks; null when it declares
 *  none this app has a table for. */
export function gcodeTableDialectOf(controller: string | null | undefined): GcodeTableDialect | null {
  let dialect: GcodeTableDialect | null = null
  if (controller === 'uccnc') dialect = 'uccnc'
  else if (controller === 'grbl' || controller === 'grblhal') dialect = 'grbl'
  else if (controller === 'linuxcnc') dialect = 'linuxcnc'
  else if (controller === 'generic') dialect = 'generic'

  if (dialect !== null) {
    selected = {}
    selectedController = {}
    return dialect
  }

  if (!controller) return null
  const table = registeredControllers.get(controller)
  if (!table) return null
  selected = { [table.dialect]: table }
  selectedController = { [table.dialect]: controller }
  return table.dialect

}

/** The word table every route reads for this dialect. */
export function gcodeWordTable(dialect: GcodeTableDialect): GcodeWordTable {
  return overrides[dialect] ?? selected[dialect] ?? BUILT_IN[dialect]
}

/**
 * Put a different table in force for one dialect, and get back the call that
 * restores the previous one. Every route reads the table at the moment it
 * judges a word, so a table without `G43` is refused by all of them at once.
 */
export function useGcodeWordTable(table: GcodeWordTable): () => void {
  const previous = overrides[table.dialect]
  overrides = { ...overrides, [table.dialect]: table }
  return () => {
    if (previous === undefined) {
      const next = { ...overrides }
      delete next[table.dialect]
      overrides = next
    } else {
      overrides = { ...overrides, [table.dialect]: previous }
    }
  }
}

/** The same table without some of its words. */
export function gcodeWordTableWithout(table: GcodeWordTable, words: readonly string[]): GcodeWordTable {
  const drop = new Set(words.map((word) => spellGcodeWord(word[0], Number(word.slice(1)))))
  return { ...table, entries: table.entries.filter((e) => !drop.has(e.word)) }
}

/** `G90.10` and `g90.1` are both `G90.1`. */
export function spellGcodeWord(letter: string, value: number): string {
  return `${letter.toUpperCase()}${Number(value.toFixed(4))}`
}

export function gcodeWordEntry(table: GcodeWordTable, letter: string, value: number): GcodeWordEntry | null {
  const word = spellGcodeWord(letter, value)
  return table.entries.find((e) => e.word === word) ?? null
}

/** Is this M-code one the controller runs as a user macro? */
export function isGcodeMacroMCode(table: GcodeWordTable, value: number): boolean {
  const range = table.macroMCodes
  if (!Number.isInteger(value)) return false
  if (table.boundMacroMCodes?.includes(value) === true) return true
  if (range === null) return false
  return value >= range.from && (range.to === null || value <= range.to)
}

/** Every number the table carries for one letter. */
export function gcodeTableCodes(table: GcodeWordTable, letter: 'G' | 'M'): Set<number> {
  return new Set(table.entries.filter((e) => e.letter === letter).map((e) => e.value))
}

/** The words of one category, in table order. */
export function gcodeTableCategory(table: GcodeWordTable, category: GcodeWordCategory): GcodeWordEntry[] {
  return table.entries.filter((e) => e.category === category)
}

/** The table's modal groups, each with the numbers of its G words. */
export function gcodeModalGroups(table: GcodeWordTable, letter: 'G' | 'M'): Array<{ name: string; codes: Set<number> }> {
  const groups = new Map<string, Set<number>>()
  for (const e of table.entries) {
    if (e.letter !== letter || e.modalGroup === null) continue
    const codes = groups.get(e.modalGroup) ?? new Set<number>()
    codes.add(e.value)
    groups.set(e.modalGroup, codes)
  }
  return [...groups].map(([name, codes]) => ({ name, codes }))
}

/** "motion G0 G1 G2 G3; dwell G4; ..." - every word the table carries, by category. */
export function describeGcodeWordTable(table: GcodeWordTable): string {
  const byCategory = new Map<string, string[]>()
  for (const e of table.entries) {
    const words = byCategory.get(e.category) ?? []
    words.push(e.word)
    byCategory.set(e.category, words)
  }
  const parts = [...byCategory].map(([category, words]) => `${category} ${words.join(' ')}`)
  const macros = table.macroMCodes
  if (macros !== null) {
    parts.push(`user macros M${macros.from}${macros.to === null ? ' and up' : `-M${macros.to}`}`)
  }
  return parts.join('; ')
}

/**
 * THE ONE SENTENCE FOR A WORD THE TABLE DOES NOT CARRY. Every route says this
 * and nothing else, so reader, MDI and loaded program refuse a word identically.
 */
export function gcodeWordRefusal(table: GcodeWordTable, letter: string, value: number): string {
  return `${spellGcodeWord(letter, value)} is not in the ${table.label} G-code word table, so it was not run. `
    + `The table carries: ${describeGcodeWordTable(table)}.`
}

/** The sentence for a user macro call on a route that cannot run one. */
export function gcodeMacroRefusal(table: GcodeWordTable, value: number): string {
  return `${spellGcodeWord('M', value)} calls a ${table.label} user macro, and this route does not run macros, `
    + 'so it was not run'
}

/** The table's sentence for a word, or null when the table carries it (or the
 *  controller runs it as a user macro). */
export function gcodeWordRefusalIfAbsent(table: GcodeWordTable, letter: string, value: number): string | null {
  if (gcodeWordEntry(table, letter, value) !== null) return null
  if (letter.toUpperCase() === 'M' && isGcodeMacroMCode(table, value)) return null
  return gcodeWordRefusal(table, letter, value)
}

// ============================================================
// WO-1650 - THE TABLE LEARNS A MACHINE'S OWN OUTPUT WORDS
// ============================================================
// Operator ruling 2026-09-17: "They define the pins. They point them at the use cases
// like a pump or a vacuum or whatever they want to run in the macro and it
// works." A machine definition's output list names the words that switch its
// outputs; a word it names that the dialect does not carry (a pump on M10) is
// THAT MACHINE'S word, and every route that reads the table reads it too. So
// the post can never write an output word the reader then refuses.
//
// A word the dialect already carries keeps the dialect's meaning (M7/M8/M9 are
// coolant words the reader tracks as coolant; the definition decides only
// which pin they switch). A word switched BESIDE a controller word of its own
// (a relay on the spindle's M3) is that word and nothing more.
// ============================================================

/** What the table needs to know about one listed output - the shape of
 *  `MachineOutputDefinition`, kept structural so this module imports nothing
 *  from the machine layer. */
export interface GcodeOutputSource {
  name: string
  onCode: string
  offCode: string | null
  besideWord?: boolean
}

/** One listed output word: which output (named by its on word) it switches,
 *  and which way. */
export interface GcodeOutputWord {
  code: number
  name: string
  on: boolean
  /** The on word's number, which is how the output is named in a program's
   *  output state. */
  onCode: number
}

const outputCodeNumber = (word: string | null | undefined): number | null => {
  if (typeof word !== 'string' || !/^M\d+$/i.test(word.trim())) return null
  return Number(word.trim().slice(1))
}

/**
 * The words a definition's output list adds to a dialect's table, keyed by
 * code. Words the dialect's built-in table already carries are left to the
 * dialect; so are outputs switched beside a controller word.
 */
export function gcodeOutputWords(
  dialect: GcodeTableDialect,
  outputs: readonly GcodeOutputSource[] | null | undefined,
): Map<number, GcodeOutputWord[]> {
  const words = new Map<number, GcodeOutputWord[]>()
  const builtIn = gcodeTableCodes(BUILT_IN[dialect], 'M')
  for (const output of outputs ?? []) {
    if (output.besideWord === true) continue
    const onCode = outputCodeNumber(output.onCode)
    if (onCode === null) continue
    const push = (code: number | null, on: boolean) => {
      if (code === null || builtIn.has(code)) return
      const list = words.get(code) ?? []
      list.push({ code, name: output.name, on, onCode })
      words.set(code, list)
    }
    push(onCode, true)
    push(outputCodeNumber(output.offCode), false)
  }
  return words
}

/** The dialect's table with this machine's own output words added, each
 *  meaning what the definition says it switches. */
export function gcodeWordTableWithOutputs(
  table: GcodeWordTable,
  outputs: readonly GcodeOutputSource[] | null | undefined,
): GcodeWordTable {
  const words = gcodeOutputWords(table.dialect, outputs)
  if (words.size === 0) return table
  const known = gcodeTableCodes(table, 'M')
  const added: GcodeWordEntry[] = []
  for (const [code, list] of words) {
    if (known.has(code)) continue
    const meaning = list
      .map((w) => `switches the "${w.name}" output ${w.on ? 'on' : 'off'}`)
      .join(' and ')
    added.push({ word: `M${code}`, letter: 'M', value: code, category: 'output', modalGroup: null, meaning })
  }
  if (added.length === 0) return table
  const entries = [...table.entries, ...added]
    .sort((a, b) => (a.letter === b.letter ? a.value - b.value : a.letter < b.letter ? -1 : 1))
  return { ...table, entries }
}

// ============================================================
// WO-1643 - WHAT COUNTS AS A MACRO CALL COMES FROM THE MACHINE
// ============================================================
// A machine's macro M-codes are the codes its macros are bound to, plus the
// range its definition states. The dialect's range (UCCNC M1000 and up,
// LinuxCNC M100-M199, GRBL none) is only the default for a machine that
// states none. A code the table carries keeps its standard meaning, bound or
// not (WO-1652's one rule).
// ============================================================

/** What the table needs to know about a machine's macros - the shape of
 *  `MachineConfig`'s fields, kept structural like `GcodeOutputSource`. */
export interface GcodeMacroSource {
  macroMCodeRange?: { from: number; to: number | null } | null
  macros?: readonly { mCode?: number; hidden?: boolean }[]
}

/** A stated range that is a range; anything else states nothing. */
function statedMacroRange(
  range: GcodeMacroSource['macroMCodeRange'],
): GcodeWordTable['macroMCodes'] | undefined {
  if (range === null) return null
  if (range === undefined || !Number.isInteger(range.from) || range.from < 0) return undefined
  if (range.to === null) return { from: range.from, to: null }
  if (!Number.isInteger(range.to) || range.to < range.from) return undefined
  return { from: range.from, to: range.to }
}

/** The table with THIS MACHINE'S macro M-codes: its stated range in place of
 *  the dialect's, and every code its macros are bound to that the table does
 *  not already carry as a word. */
export function gcodeWordTableForMachine(
  table: GcodeWordTable,
  machine: GcodeMacroSource | null | undefined,
): GcodeWordTable {
  if (machine == null) return table
  const stated = statedMacroRange(machine.macroMCodeRange)
  const known = gcodeTableCodes(table, 'M')
  // WO-2657: a macro hidden from the Macros panel binds nothing.
  const bound = [...new Set((machine.macros ?? [])
    .filter((macro) => !macro.hidden)
    .map((macro) => macro.mCode)
    .filter((code): code is number => typeof code === 'number' && Number.isInteger(code) && !known.has(code)))]
    .sort((a, b) => a - b)
  if (stated === undefined && bound.length === 0) return table
  return {
    ...table,
    ...(stated === undefined ? {} : { macroMCodes: stated }),
    ...(bound.length === 0 ? {} : { boundMacroMCodes: bound }),
  }
}
