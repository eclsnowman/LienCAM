// WO-411 slice 1 - the probe routine format: types for the contract's section 2
// (docs/research/probe-routine-format.md) and the STATIC validator (section
// 2.7). Nothing here moves the machine, evaluates against a profile, or reads
// an envelope; expansion (slice 2) and the runner (slice 3) consume the typed
// routine this module returns.
//
// Every error carries its code, the step it names (number / kind / name), a
// JSON path, and the full rendered sentence:
//   Step <n> (<kind> '<name>'): <sentence>.
//   Routine '<name>': <sentence>.
//   Input '<name>': <sentence>.
//   Output <n> (<kind>): <sentence>.

import {
  checkExprNames,
  findConstantZeroDivisor,
  parseExpr,
  type ExprAst,
  type ExprInputType,
  type ExprNameAvailability,
  type ExprNameScope,
} from './probeRoutineExpr'

export const PROBE_ROUTINE_SCHEMA_VERSION = 1

export const PROBE_ROUTINE_LIMITS = {
  maxInputs: 16,
  maxSteps: 64,
  maxOutputs: 8,
  maxReportItems: 12,
  maxBranchDepth: 2,
  maxNameLength: 60,
  maxDescriptionLength: 400,
  maxHelpLength: 200,
  enumOptionsMin: 2,
  enumOptionsMax: 8,
} as const

// --- types (section 2) ----------------------------------------------------

/** A string in the expression language, or a JSON number where a literal is meant. */
export type ProbeRoutineExpression = string | number

export type ProbeRoutineProvenanceKind = 'factory' | 'user' | 'imported'

export interface ProbeRoutineProvenance {
  kind: ProbeRoutineProvenanceKind
  importedFrom?: string
  importedAt?: string
  reviewedHash?: string
}

export interface ProbeRoutineRequires {
  homed: boolean
  envelope: 'full' | 'axis'
  probe: 'touch' | 'toolSetter'
}

interface ProbeRoutineInputBase {
  name: string
  label: string
  help?: string
}

export interface ProbeRoutineLengthInput extends ProbeRoutineInputBase {
  type: 'length'
  unit: 'mm'
  min: number
  max: number
  default: number
}

export interface ProbeRoutineAngleInput extends ProbeRoutineInputBase {
  type: 'angle'
  unit: 'deg'
  min: number
  max: number
  default: number
}

export interface ProbeRoutineCountInput extends ProbeRoutineInputBase {
  type: 'count'
  min: number
  max: number
  default: number
}

export interface ProbeRoutineEnumInput extends ProbeRoutineInputBase {
  type: 'enum'
  options: string[]
  default: string
}

export type ProbeRoutineInput =
  | ProbeRoutineLengthInput
  | ProbeRoutineAngleInput
  | ProbeRoutineCountInput
  | ProbeRoutineEnumInput

/** `$input.<enumName>` where a step field accepts an enum literal. */
export type ProbeRoutineEnumRef = `$input.${string}`

export type ProbeRoutineAxis = 'X' | 'Y' | 'Z'
export type ProbeRoutineDirection = '+' | '-'
export type ProbeRoutineWcs = 'active' | 'G54' | 'G55' | 'G56' | 'G57' | 'G58' | 'G59'
export type ProbeRoutineCalcUnit = 'mm' | 'deg' | 'count' | 'ratio'

export type ProbeRoutineComparator = '<' | '<=' | '>' | '>=' | '==' | '!='

export interface ProbeRoutineComparison {
  cmp: ProbeRoutineComparator
  left: ProbeRoutineExpression
  right: ProbeRoutineExpression
}

export type ProbeRoutineCondition =
  | ProbeRoutineComparison
  | { all: ProbeRoutineComparison[] }
  | { any: ProbeRoutineComparison[] }

export interface ProbeRoutineMoveStep {
  kind: 'move'
  name?: string
  frame?: 'start' | 'machine'
  to: { x?: ProbeRoutineExpression; y?: ProbeRoutineExpression; z?: ProbeRoutineExpression }
  feed?: 'position' | 'rapid'
  safeZ?: ProbeRoutineExpression
  /** WO-2073: a straight move that stops if the probe touches anything (a
   *  probe move, never a plain one) - a Z descent, or (WO-2088) an angled or
   *  sideways move that also travels in X and/or Y. A named one is read as
   *  `touch.<name>`: x / y / z are where it stopped - the contact, or its
   *  target when nothing was touched; value is its Z. */
  stopOnContact?: boolean
}

export interface ProbeRoutineTouchStep {
  kind: 'touch'
  name: string
  axis: ProbeRoutineAxis | ProbeRoutineEnumRef
  direction: ProbeRoutineDirection | ProbeRoutineEnumRef
  searchMm: ProbeRoutineExpression
  retractMm?: ProbeRoutineExpression
  backoffMm?: ProbeRoutineExpression
  searchFeedFactor?: number
  finalFeedFactor?: number
}

export interface ProbeRoutineCalcStep {
  kind: 'calc'
  name: string
  unit: ProbeRoutineCalcUnit
  expr: ProbeRoutineExpression
}

export interface ProbeRoutineCheckStep {
  kind: 'check'
  name?: string
  condition: ProbeRoutineCondition
  message: string
}

export interface ProbeRoutineBranchStep {
  kind: 'branch'
  name?: string
  condition: ProbeRoutineCondition
  then: ProbeRoutineStep[]
  else?: ProbeRoutineStep[]
}

export type ProbeRoutineStep =
  | ProbeRoutineMoveStep
  | ProbeRoutineTouchStep
  | ProbeRoutineCalcStep
  | ProbeRoutineCheckStep
  | ProbeRoutineBranchStep

export type ProbeRoutineStepKind = ProbeRoutineStep['kind']
export const PROBE_ROUTINE_STEP_KINDS: readonly ProbeRoutineStepKind[] = ['move', 'touch', 'calc', 'check', 'branch']

export interface ProbeRoutineWorkOffsetOutput {
  kind: 'workOffset'
  wcs: ProbeRoutineWcs | ProbeRoutineEnumRef
  axes: { X?: ProbeRoutineExpression; Y?: ProbeRoutineExpression; Z?: ProbeRoutineExpression }
  label: string
  compensationNote?: string
}

export interface ProbeRoutineToolLengthOutput {
  kind: 'toolLength'
  tool: 'active' | number
  machineZ: ProbeRoutineExpression
  label: string
}

export interface ProbeRoutineReportItem {
  label: string
  expr: ProbeRoutineExpression
  unit: ProbeRoutineCalcUnit
}

export interface ProbeRoutineReportOutput {
  kind: 'report'
  items: ProbeRoutineReportItem[]
}

export type ProbeRoutineOutput =
  | ProbeRoutineWorkOffsetOutput
  | ProbeRoutineToolLengthOutput
  | ProbeRoutineReportOutput

export type ProbeRoutineOutputKind = ProbeRoutineOutput['kind']
export const PROBE_ROUTINE_OUTPUT_KINDS: readonly ProbeRoutineOutputKind[] = ['workOffset', 'toolLength', 'report']

export interface ProbeRoutine {
  schemaVersion: typeof PROBE_ROUTINE_SCHEMA_VERSION
  id: string
  name: string
  version: string
  provenance: ProbeRoutineProvenance
  description: string
  requires: ProbeRoutineRequires
  inputs: ProbeRoutineInput[]
  steps: ProbeRoutineStep[]
  outputs: ProbeRoutineOutput[]
}

// --- errors (section 2.7, static) ----------------------------------------

export type ProbeRoutineStaticErrorCode =
  | 'E_SCHEMA_MISSING'
  | 'E_SCHEMA_NEWER'
  | 'E_UNKNOWN_FIELD'
  | 'E_ID_RESERVED'
  | 'E_INPUT_UNBOUNDED'
  | 'E_INPUT_DEFAULT_OUT_OF_RANGE'
  | 'E_STEP_KIND'
  | 'E_STEP_NAME_DUPLICATE'
  | 'E_TOUCH_DIRECTION'
  | 'E_FEED_ABOVE_PROFILE'
  | 'E_EXPR_UNBOUNDED'
  | 'E_EXPR_UNKNOWN_NAME'
  | 'E_EXPR_FORWARD_REFERENCE'
  | 'E_EXPR_ENUM_IN_ARITHMETIC'
  | 'E_BRANCH_DEPTH'
  | 'E_REQUIRES_HOMED'
  | 'E_GCODE_IN_ROUTINE'
  | 'E_OUTPUT_KIND'
  | 'E_TOO_MANY_STEPS'
  | 'E_CALC_NOT_FINITE'
  /** Shape/type/range faults the contract gives no dedicated code for
   *  (a missing required field, a wrong type, a name outside its pattern). */
  | 'E_FIELD_INVALID'

export type ProbeRoutineExpansionErrorCode =
  | 'E_ENVELOPE_INCOMPLETE'
  | 'E_ENDPOINT_OUTSIDE_ENVELOPE'
  | 'E_SEARCH_OVER_MAX_TRAVEL'
  | 'E_RAPID_NOT_AT_SAFE_Z'
  | 'E_CALC_NOT_FINITE'
  | 'E_INPUT_OUT_OF_RANGE'
  | 'E_PROBE_CONFIG_INVALID'

export type ProbeRoutineRunErrorCode =
  | 'E_NOT_HOMED'
  | 'E_NOT_IDLE'
  | 'E_ESTOP'
  | 'E_PATH_NOT_CONFIRMED'
  | 'E_PREVIEW_STALE'
  | 'E_IMPORTED_NOT_REVIEWED'
  | 'E_TOUCH_MISSED'
  | 'E_CONTROLLER_REFUSED'

export type RoutineErrorCode =
  | ProbeRoutineStaticErrorCode
  | ProbeRoutineExpansionErrorCode
  | ProbeRoutineRunErrorCode

export interface RoutineErrorStepRef {
  /** 1-based, document order, nested branch-arm steps counted in place. */
  number: number
  kind: string | null
  name: string | null
}

export interface RoutineError {
  code: RoutineErrorCode
  where: 'routine' | 'input' | 'step' | 'output'
  /** The step the error names; null for routine / input / output errors. */
  step: RoutineErrorStepRef | null
  /** 1-based input or output index when `where` is input / output. */
  index: number | null
  /** Dotted path into the JSON, e.g. "steps[4].expr". */
  path: string
  /** The plain sentence, without prefix, ending in a full stop. */
  detail: string
  /** The fully rendered line: prefix + detail. */
  sentence: string
}

export interface ValidateProbeRoutineOptions {
  /**
   * Profile feeds in mm/min, used only to name the number in the
   * E_FEED_ABOVE_PROFILE sentence. The validator never uses them to decide.
   */
  profileFeeds?: { searchMmMin?: number; finalMmMin?: number }
}

export type ValidateProbeRoutineResult =
  | { ok: true; routine: ProbeRoutine; errors: [] }
  | { ok: false; routine: null; errors: RoutineError[] }

// --- small helpers ----------------------------------------------------------

const ID_RE = /^[a-z0-9][a-z0-9.-]{2,63}$/
const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const ENUM_REF_RE = /^\$input\.([a-zA-Z][a-zA-Z0-9_]{0,31})$/

const AXES: readonly string[] = ['X', 'Y', 'Z']
const DIRECTIONS: readonly string[] = ['+', '-']
const WCS_VALUES: readonly string[] = ['active', 'G54', 'G55', 'G56', 'G57', 'G58', 'G59']
const CALC_UNITS: readonly string[] = ['mm', 'deg', 'count', 'ratio']
const COMPARATORS: readonly string[] = ['<', '<=', '>', '>=', '==', '!=']

const TOP_LEVEL_KEYS = [
  'schemaVersion', 'id', 'name', 'version', 'provenance', 'description', 'requires', 'inputs', 'steps', 'outputs',
] as const
const PROVENANCE_KEYS = ['kind', 'importedFrom', 'importedAt', 'reviewedHash'] as const
const REQUIRES_KEYS = ['homed', 'envelope', 'probe'] as const
const INPUT_KEYS = ['name', 'label', 'type', 'unit', 'min', 'max', 'default', 'options', 'help'] as const
const MOVE_KEYS = ['kind', 'name', 'frame', 'to', 'feed', 'safeZ', 'stopOnContact'] as const
const TOUCH_KEYS = ['kind', 'name', 'axis', 'direction', 'searchMm', 'retractMm', 'backoffMm', 'searchFeedFactor', 'finalFeedFactor'] as const
const CALC_KEYS = ['kind', 'name', 'unit', 'expr'] as const
const CHECK_KEYS = ['kind', 'name', 'condition', 'message'] as const
const BRANCH_KEYS = ['kind', 'name', 'condition', 'then', 'else'] as const
const COMPARISON_KEYS = ['cmp', 'left', 'right'] as const
const WORK_OFFSET_KEYS = ['kind', 'wcs', 'axes', 'label', 'compensationNote'] as const
const TOOL_LENGTH_KEYS = ['kind', 'tool', 'machineZ', 'label'] as const
const REPORT_KEYS = ['kind', 'items'] as const
const REPORT_ITEM_KEYS = ['label', 'expr', 'unit'] as const

type Obj = Record<string, unknown>

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function quote(value: unknown): string {
  if (typeof value === 'string') return `"${value.length > 60 ? `${value.slice(0, 57)}...` : value}"`
  if (value === undefined) return 'nothing'
  try {
    const text = JSON.stringify(value)
    return text.length > 60 ? `${text.slice(0, 57)}...` : text
  } catch {
    return String(value)
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a list'
  return typeof value === 'object' ? 'an object' : typeof value === 'string' ? 'text' : typeof value
}

// --- the no-gcode scan (E_GCODE_IN_ROUTINE) -----------------------------------

interface GcodeMatch {
  what: string
  tail: string
}

const GCODE_TAIL = 'A routine cannot send commands; it can only move, touch, calculate, check and branch.'

/**
 * Classify a string field that carries a command. Returns null when the text
 * is clean. Defensive (section 2.6): the boundary is the closed vocabulary,
 * this just refuses text that looks like a command before it gets anywhere.
 */
export function findCommandText(text: string): GcodeMatch | null {
  if (/\bG10\b/.test(text)) {
    return {
      what: 'is a work-offset write',
      tail: 'Offsets are set only by the Confirm button after the routine, never from inside it.',
    }
  }
  if (/\bG43\.1\b|\bG49\b|\bG43\b/.test(text)) {
    return {
      what: 'is a tool-length-offset command',
      tail: 'Tool lengths are recorded only by the Confirm button after the routine, never from inside it.',
    }
  }
  if (/\$H\b/.test(text)) return { what: 'is a homing command', tail: GCODE_TAIL }
  if (/\$X\b/.test(text)) return { what: 'is an unlock command', tail: GCODE_TAIL }
  if (/\$J=/.test(text)) return { what: 'is a jog command', tail: GCODE_TAIL }
  if (/\$\d+\s*=/.test(text)) return { what: 'is a settings write', tail: GCODE_TAIL }
  if (/\$RST\b/.test(text)) return { what: 'is a settings reset', tail: GCODE_TAIL }
  if (/\bM\d+\b/.test(text)) return { what: 'is an M-code (spindle, coolant or program control)', tail: GCODE_TAIL }
  if (/[!~]/.test(text) || text.includes('\x18')) {
    return { what: 'is a real-time control character (feed hold, cycle start or reset)', tail: GCODE_TAIL }
  }
  if (/\bG\d+(?:\.\d+)?\b/.test(text)) {
    const words = text.match(/\bG\d+(?:\.\d+)?\b/g) ?? []
    const offending = words.filter((w) => !/^G5[4-9]$/.test(w))
    if (offending.length > 0) return { what: 'is G-code', tail: GCODE_TAIL }
  }
  return null
}

// --- the validator -------------------------------------------------------------

interface StepCursor {
  number: number
  kind: string | null
  name: string | null
}

/** Flat, pre-order step numbering: branch arms count in place. */
interface IndexedStep {
  number: number
  raw: unknown
  path: string
  depth: number
  /** The chain of enclosing branch arms, outermost first, as '<branch number>.then' / '.else'. */
  arms: string[]
}

class Validator {
  readonly errors: RoutineError[] = []
  private routineLabel = "''"
  private inputTypes = new Map<string, ExprInputType>()
  private enumOptions = new Map<string, string[]>()
  /** name -> { number, kind, arms } for every touch / calc in the routine. */
  private touchIndex = new Map<string, { number: number; arms: string[] }>()
  private calcIndex = new Map<string, { number: number; arms: string[] }>()
  private feeds: ValidateProbeRoutineOptions['profileFeeds']

  constructor(options: ValidateProbeRoutineOptions) {
    this.feeds = options.profileFeeds
  }

  // -- emit helpers

  private routineError(code: RoutineErrorCode, path: string, detail: string): void {
    this.errors.push({
      code,
      where: 'routine',
      step: null,
      index: null,
      path,
      detail,
      sentence: `Routine ${this.routineLabel}: ${detail}`,
    })
  }

  private inputError(code: RoutineErrorCode, index: number, name: string | null, path: string, detail: string): void {
    const prefix = name ? `Input '${name}'` : `Input ${index}`
    this.errors.push({ code, where: 'input', step: null, index, path, detail, sentence: `${prefix}: ${detail}` })
  }

  private stepError(code: RoutineErrorCode, cursor: StepCursor, path: string, detail: string): void {
    const prefix = cursor.kind === null
      ? `Step ${cursor.number}`
      : cursor.name
        ? `Step ${cursor.number} (${cursor.kind} '${cursor.name}')`
        : `Step ${cursor.number} (${cursor.kind})`
    this.errors.push({
      code,
      where: 'step',
      step: { number: cursor.number, kind: cursor.kind, name: cursor.name },
      index: null,
      path,
      detail,
      sentence: `${prefix}: ${detail}`,
    })
  }

  private outputError(code: RoutineErrorCode, index: number, kind: string | null, path: string, detail: string): void {
    const prefix = kind ? `Output ${index} (${kind})` : `Output ${index}`
    this.errors.push({ code, where: 'output', step: null, index, path, detail, sentence: `${prefix}: ${detail}` })
  }

  // -- generic shape checks

  private unknownKeys(
    obj: Obj,
    known: readonly string[],
    emit: (code: RoutineErrorCode, path: string, detail: string) => void,
    path: string,
  ): void {
    for (const key of Object.keys(obj)) {
      if (!known.includes(key)) {
        emit(
          'E_UNKNOWN_FIELD',
          path ? `${path}.${key}` : key,
          `the field '${key}' is not part of the routine format; no field may be silently ignored, so it must be removed.`,
        )
      }
    }
  }

  /** Every string anywhere under `value` goes through the no-gcode scan. */
  private scanStrings(
    value: unknown,
    path: string,
    emit: (code: RoutineErrorCode, path: string, detail: string) => void,
    skipKey?: string,
  ): void {
    if (typeof value === 'string') {
      const match = findCommandText(value)
      if (match) emit('E_GCODE_IN_ROUTINE', path, `the text ${quote(value)} ${match.what}. ${match.tail}`)
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => this.scanStrings(item, `${path}[${i}]`, emit, skipKey))
      return
    }
    if (isObj(value)) {
      for (const [key, inner] of Object.entries(value)) {
        if (key === skipKey) continue
        // nested steps are scanned by their own visit
        if (key === 'then' || key === 'else') continue
        this.scanStrings(inner, `${path}.${key}`, emit, skipKey)
      }
    }
  }

  // -- top level

  validate(json: unknown): void {
    if (!isObj(json)) {
      this.routineError('E_FIELD_INVALID', '', `a routine must be a JSON object, not ${describeType(json)}.`)
      return
    }
    const name = json.name
    const id = json.id
    this.routineLabel = typeof name === 'string' && name.length > 0
      ? `'${name}'`
      : typeof id === 'string' && id.length > 0
        ? `'${id}'`
        : "'(unnamed)'"

    // schema version first: a newer file is refused before anything else is read
    const schemaVersion = json.schemaVersion
    if (schemaVersion === undefined) {
      this.routineError('E_SCHEMA_MISSING', 'schemaVersion', 'the file does not say which routine format it uses (`schemaVersion` is missing).')
    } else if (!Number.isInteger(schemaVersion)) {
      this.routineError('E_SCHEMA_MISSING', 'schemaVersion', `\`schemaVersion\` must be a whole number; it is ${quote(schemaVersion)}.`)
    } else if ((schemaVersion as number) > PROBE_ROUTINE_SCHEMA_VERSION) {
      this.routineError(
        'E_SCHEMA_NEWER',
        'schemaVersion',
        `this routine was saved by a newer LienCAM (format ${schemaVersion}); this version reads format ${PROBE_ROUTINE_SCHEMA_VERSION}.`,
      )
      return
    } else if ((schemaVersion as number) < PROBE_ROUTINE_SCHEMA_VERSION) {
      this.routineError(
        'E_SCHEMA_MISSING',
        'schemaVersion',
        `this routine uses format ${schemaVersion}; this version reads format ${PROBE_ROUTINE_SCHEMA_VERSION} and does not migrate older files.`,
      )
    }

    this.unknownKeys(json, TOP_LEVEL_KEYS, (c, p, d) => this.routineError(c, p, d), '')

    // requires.homed is judged from the steps, and is reported FIRST (contract 3.5 order)
    this.checkRequires(json.requires, json.steps)

    // id / name / version / provenance / description
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      this.routineError('E_FIELD_INVALID', 'id', `\`id\` must be 3 to 64 characters of lower-case letters, digits, dots and dashes, starting with a letter or digit; it is ${quote(id)}.`)
    } else if (id.startsWith('factory.') && !(isObj(json.provenance) && json.provenance.kind === 'factory')) {
      this.routineError('E_ID_RESERVED', 'id', `the id '${id}' begins with 'factory.', which is reserved for the routines shipped inside LienCAM; choose another id.`)
    }
    if (typeof name !== 'string' || name.length < 1 || name.length > PROBE_ROUTINE_LIMITS.maxNameLength) {
      this.routineError('E_FIELD_INVALID', 'name', `\`name\` must be 1 to ${PROBE_ROUTINE_LIMITS.maxNameLength} characters; it is ${quote(name)}.`)
    }
    if (typeof json.version !== 'string' || !SEMVER_RE.test(json.version)) {
      this.routineError('E_FIELD_INVALID', 'version', `\`version\` must be a semver string like "1.0.0"; it is ${quote(json.version)}.`)
    }
    this.checkProvenance(json.provenance)
    if (typeof json.description !== 'string' || json.description.length > PROBE_ROUTINE_LIMITS.maxDescriptionLength) {
      this.routineError('E_FIELD_INVALID', 'description', `\`description\` must be text of at most ${PROBE_ROUTINE_LIMITS.maxDescriptionLength} characters; it is ${quote(json.description)}.`)
    }
    // top-level strings (not inputs/steps/outputs - they scan themselves with their own prefixes)
    for (const key of ['id', 'name', 'version', 'description'] as const) {
      this.scanStrings(json[key], key, (c, p, d) => this.routineError(c, p, d))
    }
    this.scanStrings(json.provenance, 'provenance', (c, p, d) => this.routineError(c, p, d))

    this.checkInputs(json.inputs)
    this.checkSteps(json.steps)
    this.checkOutputs(json.outputs)
  }

  private checkProvenance(value: unknown): void {
    if (!isObj(value)) {
      this.routineError('E_FIELD_INVALID', 'provenance', `\`provenance\` must be an object like { "kind": "user" }; it is ${quote(value)}.`)
      return
    }
    this.unknownKeys(value, PROVENANCE_KEYS, (c, p, d) => this.routineError(c, p, d), 'provenance')
    if (value.kind !== 'factory' && value.kind !== 'user' && value.kind !== 'imported') {
      this.routineError('E_FIELD_INVALID', 'provenance.kind', `\`provenance.kind\` must be "factory", "user" or "imported"; it is ${quote(value.kind)}.`)
    }
    for (const key of ['importedFrom', 'importedAt', 'reviewedHash'] as const) {
      if (value[key] !== undefined && typeof value[key] !== 'string') {
        this.routineError('E_FIELD_INVALID', `provenance.${key}`, `\`provenance.${key}\` must be text when present; it is ${quote(value[key])}.`)
      }
    }
  }

  private checkRequires(value: unknown, rawSteps: unknown): void {
    if (!isObj(value)) {
      this.routineError('E_REQUIRES_HOMED', 'requires', `\`requires\` must be an object like { "homed": true, "envelope": "full", "probe": "touch" }; it is ${quote(value)}.`)
      return
    }
    this.unknownKeys(value, REQUIRES_KEYS, (c, p, d) => this.routineError(c, p, d), 'requires')
    const { homed, envelope, probe } = value
    if (typeof homed !== 'boolean') {
      this.routineError('E_REQUIRES_HOMED', 'requires.homed', `\`requires.homed\` must be true or false; it is ${quote(homed)}.`)
    }
    if (envelope !== 'full' && envelope !== 'axis') {
      this.routineError('E_REQUIRES_HOMED', 'requires.envelope', `\`requires.envelope\` must be "full" or "axis"; it is ${quote(envelope)}.`)
    }
    if (probe !== 'touch' && probe !== 'toolSetter') {
      this.routineError('E_FIELD_INVALID', 'requires.probe', `\`requires.probe\` must be "touch" or "toolSetter"; it is ${quote(probe)}.`)
    }
    if (typeof homed !== 'boolean') return

    // what the body actually does
    const firstMove = this.findFirstMove(rawSteps)
    const touchCount = this.countKind(rawSteps, 'touch')
    if (homed === false) {
      const reasons: string[] = []
      if (firstMove) {
        reasons.push(`it moves the machine (step ${firstMove.number}${firstMove.name ? ` '${firstMove.name}'` : ''})`)
      }
      if (touchCount > 1) reasons.push(`touches ${touchCount === 2 ? 'twice' : `${touchCount} times`}`)
      if (reasons.length > 0) {
        this.routineError(
          'E_REQUIRES_HOMED',
          'requires.homed',
          `${reasons.join(' and ')}, so it must declare \`requires.homed: true\` - every endpoint is a machine coordinate and means nothing unhomed.`,
        )
      }
    } else if (envelope === 'axis') {
      this.routineError(
        'E_REQUIRES_HOMED',
        'requires.envelope',
        'it declares `requires.homed: true`, so `requires.envelope` must be "full" - a homed routine needs X, Y and Z all known.',
      )
    }
  }

  private findFirstMove(rawSteps: unknown): { number: number; name: string | null } | null {
    for (const step of this.indexSteps(rawSteps)) {
      if (isObj(step.raw) && step.raw.kind === 'move') {
        return { number: step.number, name: typeof step.raw.name === 'string' ? step.raw.name : null }
      }
    }
    return null
  }

  private countKind(rawSteps: unknown, kind: string): number {
    let count = 0
    for (const step of this.indexSteps(rawSteps)) {
      if (isObj(step.raw) && step.raw.kind === kind) count += 1
    }
    return count
  }

  /** Pre-order, flat numbering over the raw step tree (tolerant of junk). */
  private indexSteps(rawSteps: unknown): IndexedStep[] {
    const out: IndexedStep[] = []
    let number = 0
    const walk = (list: unknown, path: string, depth: number, arms: string[]): void => {
      if (!Array.isArray(list)) return
      list.forEach((raw, i) => {
        number += 1
        const myNumber = number
        const myPath = `${path}[${i}]`
        out.push({ number: myNumber, raw, path: myPath, depth, arms })
        if (isObj(raw) && raw.kind === 'branch') {
          walk(raw.then, `${myPath}.then`, depth + 1, [...arms, `${myNumber}.then`])
          walk(raw.else, `${myPath}.else`, depth + 1, [...arms, `${myNumber}.else`])
        }
      })
    }
    walk(rawSteps, 'steps', 1, [])
    return out
  }

  // -- inputs

  private checkInputs(value: unknown): void {
    if (!Array.isArray(value)) {
      this.routineError('E_FIELD_INVALID', 'inputs', `\`inputs\` must be a list (it may be empty); it is ${quote(value)}.`)
      return
    }
    if (value.length > PROBE_ROUTINE_LIMITS.maxInputs) {
      this.routineError('E_FIELD_INVALID', 'inputs', `a routine may declare at most ${PROBE_ROUTINE_LIMITS.maxInputs} inputs; this one declares ${value.length}.`)
    }
    const seen = new Set<string>()
    value.forEach((raw, i) => {
      const index = i + 1
      const path = `inputs[${i}]`
      if (!isObj(raw)) {
        this.inputError('E_FIELD_INVALID', index, null, path, `an input must be an object; it is ${quote(raw)}.`)
        return
      }
      const name = typeof raw.name === 'string' ? raw.name : null
      const emit = (code: RoutineErrorCode, p: string, d: string) => this.inputError(code, index, name, p, d)
      this.unknownKeys(raw, INPUT_KEYS, emit, path)
      this.scanStrings(raw, path, emit)
      if (name === null || !NAME_RE.test(name)) {
        emit('E_FIELD_INVALID', `${path}.name`, `an input needs a \`name\` of letters, digits and underscores starting with a letter (up to 32 characters); it is ${quote(raw.name)}.`)
      } else if (seen.has(name)) {
        emit('E_FIELD_INVALID', `${path}.name`, `the input name '${name}' is used twice; input names must be unique.`)
      } else {
        seen.add(name)
      }
      if (typeof raw.label !== 'string' || raw.label.length < 1 || raw.label.length > 60) {
        emit('E_FIELD_INVALID', `${path}.label`, `an input needs a \`label\` of 1 to 60 characters; it is ${quote(raw.label)}.`)
      }
      if (raw.help !== undefined && (typeof raw.help !== 'string' || raw.help.length > PROBE_ROUTINE_LIMITS.maxHelpLength)) {
        emit('E_FIELD_INVALID', `${path}.help`, `\`help\` must be text of at most ${PROBE_ROUTINE_LIMITS.maxHelpLength} characters.`)
      }
      const type = raw.type
      if (type !== 'length' && type !== 'angle' && type !== 'count' && type !== 'enum') {
        emit('E_FIELD_INVALID', `${path}.type`, `an input's \`type\` must be "length", "angle", "count" or "enum"; it is ${quote(type)}.`)
        return
      }
      if (name !== null) this.inputTypes.set(name, type)
      if (type === 'enum') {
        const options = raw.options
        if (raw.unit !== undefined) {
          emit('E_FIELD_INVALID', `${path}.unit`, 'a choice (enum) input has no `unit`.')
        }
        if (raw.min !== undefined || raw.max !== undefined) {
          emit('E_FIELD_INVALID', `${path}.min`, 'a choice (enum) input has no `min` or `max`; it has `options`.')
        }
        if (
          !Array.isArray(options)
          || options.length < PROBE_ROUTINE_LIMITS.enumOptionsMin
          || options.length > PROBE_ROUTINE_LIMITS.enumOptionsMax
          || !options.every((o) => typeof o === 'string' && o.length > 0)
        ) {
          emit('E_FIELD_INVALID', `${path}.options`, `a choice (enum) input needs \`options\`: ${PROBE_ROUTINE_LIMITS.enumOptionsMin} to ${PROBE_ROUTINE_LIMITS.enumOptionsMax} pieces of text.`)
          return
        }
        if (new Set(options).size !== options.length) {
          emit('E_FIELD_INVALID', `${path}.options`, 'the `options` of a choice (enum) input must all be different.')
        }
        if (name !== null) this.enumOptions.set(name, options as string[])
        if (typeof raw.default !== 'string' || !options.includes(raw.default)) {
          emit('E_INPUT_DEFAULT_OUT_OF_RANGE', `${path}.default`, `the default ${quote(raw.default)} is not one of the options (${(options as string[]).map((o) => `"${o}"`).join(', ')}).`)
        }
        return
      }
      // length / angle / count
      const expectedUnit = type === 'length' ? 'mm' : type === 'angle' ? 'deg' : undefined
      if (raw.unit !== expectedUnit) {
        emit(
          'E_FIELD_INVALID',
          `${path}.unit`,
          expectedUnit
            ? `a ${type} input's \`unit\` must be "${expectedUnit}" (the file is always ${expectedUnit}; the screen converts); it is ${quote(raw.unit)}.`
            : `a count input has no \`unit\`; it is ${quote(raw.unit)}.`,
        )
      }
      if (raw.options !== undefined) {
        emit('E_FIELD_INVALID', `${path}.options`, `only a choice (enum) input has \`options\`; this one is a ${type}.`)
      }
      const noun = type === 'length' ? 'a length' : type === 'angle' ? 'an angle' : 'a count'
      const hasMin = isFiniteNumber(raw.min)
      const hasMax = isFiniteNumber(raw.max)
      if (!hasMin || !hasMax) {
        emit('E_INPUT_UNBOUNDED', `${path}.${!hasMin ? 'min' : 'max'}`, `${noun} input needs \`min\` and \`max\`; without them the preview cannot promise where the machine will go.`)
      } else if ((raw.min as number) > (raw.max as number)) {
        emit('E_INPUT_UNBOUNDED', `${path}.min`, `\`min\` (${raw.min}) is greater than \`max\` (${raw.max}); the bounds must be min <= max.`)
      }
      if (!isFiniteNumber(raw.default)) {
        emit('E_INPUT_DEFAULT_OUT_OF_RANGE', `${path}.default`, `${noun} input needs a numeric \`default\`; it is ${quote(raw.default)}.`)
      } else {
        if (type === 'count' && !Number.isInteger(raw.default)) {
          emit('E_INPUT_DEFAULT_OUT_OF_RANGE', `${path}.default`, `a count input's default must be a whole number; it is ${raw.default}.`)
        }
        if (hasMin && hasMax && (raw.default < (raw.min as number) || raw.default > (raw.max as number))) {
          emit(
            'E_INPUT_DEFAULT_OUT_OF_RANGE',
            `${path}.default`,
            `the default ${raw.default} is outside the input's own bounds (${raw.min} to ${raw.max}${expectedUnit ? ` ${expectedUnit}` : ''}).`,
          )
        }
      }
      if (type === 'count') {
        if (hasMin && !Number.isInteger(raw.min)) emit('E_FIELD_INVALID', `${path}.min`, 'a count input\'s `min` must be a whole number.')
        if (hasMax && !Number.isInteger(raw.max)) emit('E_FIELD_INVALID', `${path}.max`, 'a count input\'s `max` must be a whole number.')
      }
    })
  }

  // -- steps

  private checkSteps(value: unknown): void {
    if (!Array.isArray(value)) {
      this.routineError('E_FIELD_INVALID', 'steps', `\`steps\` must be a list; it is ${quote(value)}.`)
      return
    }
    const indexed = this.indexSteps(value)
    if (indexed.length > PROBE_ROUTINE_LIMITS.maxSteps) {
      this.routineError(
        'E_TOO_MANY_STEPS',
        'steps',
        `a routine may have at most ${PROBE_ROUTINE_LIMITS.maxSteps} steps counting the ones inside branches; this one has ${indexed.length}.`,
      )
    }
    // first pass: names, so forward references can be named with their step number
    const seenNames = new Map<string, number>()
    for (const step of indexed) {
      if (!isObj(step.raw)) continue
      const name = step.raw.name
      if (typeof name !== 'string') continue
      const kind = step.raw.kind
      if (seenNames.has(name)) continue // duplicate, reported in the second pass; first one wins the index
      seenNames.set(name, step.number)
      // WO-2073: a descent that stops on contact records where it stopped, as a touch does.
      if (kind === 'touch' || (kind === 'move' && step.raw.stopOnContact === true)) {
        this.touchIndex.set(name, { number: step.number, arms: step.arms })
      }
      if (kind === 'calc') this.calcIndex.set(name, { number: step.number, arms: step.arms })
    }
    // second pass: everything else, in document order
    const reported = new Set<string>()
    for (const step of indexed) this.checkStep(step, reported, seenNames)
  }

  private scopeFor(step: IndexedStep): ExprNameScope {
    const availability = (entry: { number: number; arms: string[] }): ExprNameAvailability => {
      if (entry.number >= step.number) return { available: false, reason: 'later', stepNumber: entry.number }
      // usable only when the defining step's arm chain is a prefix of ours
      const inside = entry.arms.every((arm, i) => step.arms[i] === arm)
      if (!inside) return { available: false, reason: 'branch-arm', stepNumber: entry.number }
      return { available: true }
    }
    const touches = new Map<string, ExprNameAvailability>()
    for (const [name, entry] of this.touchIndex) touches.set(name, availability(entry))
    const calcs = new Map<string, ExprNameAvailability>()
    for (const [name, entry] of this.calcIndex) calcs.set(name, availability(entry))
    return { inputs: this.inputTypes, touches, calcs }
  }

  /** Names defined at top level only (outputs run after every step). */
  private outputScope(): ExprNameScope {
    const touches = new Map<string, ExprNameAvailability>()
    for (const [name, entry] of this.touchIndex) {
      touches.set(name, entry.arms.length === 0
        ? { available: true }
        : { available: false, reason: 'branch-arm', stepNumber: entry.number })
    }
    const calcs = new Map<string, ExprNameAvailability>()
    for (const [name, entry] of this.calcIndex) {
      calcs.set(name, entry.arms.length === 0
        ? { available: true }
        : { available: false, reason: 'branch-arm', stepNumber: entry.number })
    }
    return { inputs: this.inputTypes, touches, calcs }
  }

  /**
   * Parse + name-check one expression field. Emits faults through `emit` and
   * returns the AST when one exists (even when a bound was broken).
   */
  private checkExpression(
    value: unknown,
    path: string,
    scope: ExprNameScope,
    emit: (code: RoutineErrorCode, path: string, detail: string) => void,
    required: boolean,
  ): ExprAst | null {
    if (value === undefined) {
      if (required) emit('E_FIELD_INVALID', path, `\`${path.split('.').pop()}\` is required.`)
      return null
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      emit('E_FIELD_INVALID', path, `an expression must be text like "input.diameter / 2" or a number; it is ${quote(value)}.`)
      return null
    }
    const parsed = parseExpr(value)
    for (const fault of parsed.faults) emit(fault.code, path, fault.sentence)
    if (parsed.ast) {
      for (const fault of checkExprNames(parsed.ast, scope)) emit(fault.code, path, fault.sentence)
    }
    return parsed.ast
  }

  private checkCondition(
    value: unknown,
    path: string,
    scope: ExprNameScope,
    emit: (code: RoutineErrorCode, path: string, detail: string) => void,
  ): void {
    if (!isObj(value)) {
      emit('E_FIELD_INVALID', path, `\`condition\` must be a comparison { "cmp", "left", "right" } or { "all": [...] } / { "any": [...] }; it is ${quote(value)}.`)
      return
    }
    const comparison = (raw: unknown, p: string): void => {
      if (!isObj(raw)) {
        emit('E_FIELD_INVALID', p, `a comparison must be an object { "cmp", "left", "right" }; it is ${quote(raw)}.`)
        return
      }
      this.unknownKeys(raw, COMPARISON_KEYS, emit, p)
      if (typeof raw.cmp !== 'string' || !COMPARATORS.includes(raw.cmp)) {
        emit('E_FIELD_INVALID', `${p}.cmp`, `\`cmp\` must be one of < <= > >= == !=; it is ${quote(raw.cmp)}.`)
      }
      this.checkExpression(raw.left, `${p}.left`, scope, emit, true)
      this.checkExpression(raw.right, `${p}.right`, scope, emit, true)
    }
    const hasAll = 'all' in value
    const hasAny = 'any' in value
    if (hasAll || hasAny) {
      const key = hasAll ? 'all' : 'any'
      this.unknownKeys(value, [key], emit, path)
      const list = value[key]
      if (!Array.isArray(list) || list.length === 0) {
        emit('E_FIELD_INVALID', `${path}.${key}`, `\`${key}\` must be a non-empty list of comparisons.`)
        return
      }
      list.forEach((raw, i) => {
        if (isObj(raw) && ('all' in raw || 'any' in raw)) {
          emit('E_FIELD_INVALID', `${path}.${key}[${i}]`, 'a condition may not nest `all` / `any` inside `all` / `any`; one level only.')
          return
        }
        comparison(raw, `${path}.${key}[${i}]`)
      })
      return
    }
    comparison(value, path)
  }

  private checkEnumRef(
    value: unknown,
    legal: readonly string[],
    fieldName: string,
    path: string,
    code: RoutineErrorCode,
    emit: (code: RoutineErrorCode, path: string, detail: string) => void,
  ): { literal: string | null; options: string[] | null } {
    if (typeof value === 'string') {
      const ref = ENUM_REF_RE.exec(value)
      if (ref) {
        const inputName = ref[1]
        const type = this.inputTypes.get(inputName)
        if (type === undefined) {
          emit('E_EXPR_UNKNOWN_NAME', path, `\`${value}\`: '${inputName}' is not an input of this routine.`)
          return { literal: null, options: null }
        }
        if (type !== 'enum') {
          emit(code, path, `\`${fieldName}\` may only take a choice (enum) input; '${inputName}' is a ${type} input.`)
          return { literal: null, options: null }
        }
        const options = this.enumOptions.get(inputName) ?? []
        const illegal = options.filter((o) => !legal.includes(o))
        if (illegal.length > 0) {
          emit(
            code,
            path,
            `\`${fieldName}\` takes ${legal.map((l) => `"${l}"`).join(' / ')}; the input '${inputName}' offers ${illegal.map((o) => `"${o}"`).join(', ')}, which ${illegal.length === 1 ? 'is' : 'are'} not allowed here.`,
          )
        }
        return { literal: null, options }
      }
      if (legal.includes(value)) return { literal: value, options: null }
    }
    emit(code, path, `\`${fieldName}\` must be ${legal.map((l) => `"${l}"`).join(' / ')} or "$input.<choice input>"; it is ${quote(value)}.`)
    return { literal: null, options: null }
  }

  private checkStep(step: IndexedStep, reported: Set<string>, seenNames: Map<string, number>): void {
    const raw = step.raw
    const cursor: StepCursor = { number: step.number, kind: null, name: null }
    const emit = (code: RoutineErrorCode, p: string, d: string) => this.stepError(code, cursor, p, d)
    if (!isObj(raw)) {
      emit('E_STEP_KIND', step.path, `a step must be an object with a \`kind\`; it is ${quote(raw)}.`)
      return
    }
    const kind = raw.kind
    const name = typeof raw.name === 'string' ? raw.name : null
    const kindKnown = typeof kind === 'string' && (PROBE_ROUTINE_STEP_KINDS as readonly string[]).includes(kind)
    cursor.kind = kindKnown ? (kind as string) : null
    cursor.name = name

    if (!kindKnown) {
      emit(
        'E_STEP_KIND',
        `${step.path}.kind`,
        kind === undefined
          ? 'the step has no `kind`. A routine can only move, touch, calculate, check and branch.'
          : `there is no step kind ${typeof kind === 'string' ? `'${kind}'` : quote(kind)}. A routine cannot write G-code; it can only move, touch, calculate, check and branch.`,
      )
      // unknown shape, but every string in it is still scanned
      this.scanStrings(raw, step.path, emit, 'cmp')
      return
    }

    // name rules
    if (raw.name !== undefined && (typeof raw.name !== 'string' || !NAME_RE.test(raw.name))) {
      emit('E_FIELD_INVALID', `${step.path}.name`, `a step \`name\` is letters, digits and underscores starting with a letter (up to 32 characters); it is ${quote(raw.name)}.`)
    } else if (name !== null) {
      const first = seenNames.get(name)
      if (first !== undefined && first !== step.number) {
        const key = `${name}@${step.number}`
        if (!reported.has(key)) {
          reported.add(key)
          emit('E_STEP_NAME_DUPLICATE', `${step.path}.name`, `the name '${name}' is already used by step ${first}; step names must be unique so results can be referenced.`)
        }
      }
    }
    if ((kind === 'touch' || kind === 'calc') && name === null) {
      emit('E_FIELD_INVALID', `${step.path}.name`, `a ${kind} step needs a \`name\` - its result is referenced as ${kind}.<name>.`)
    }

    this.scanStrings(raw, step.path, emit, 'cmp')
    const scope = this.scopeFor(step)

    switch (kind) {
      case 'move':
        this.checkMove(raw, step, scope, emit)
        break
      case 'touch':
        this.checkTouch(raw, step, scope, emit)
        break
      case 'calc':
        this.checkCalc(raw, step, scope, emit)
        break
      case 'check':
        this.unknownKeys(raw, CHECK_KEYS, emit, step.path)
        this.checkCondition(raw.condition, `${step.path}.condition`, scope, emit)
        if (typeof raw.message !== 'string' || raw.message.length < 1) {
          emit('E_FIELD_INVALID', `${step.path}.message`, 'a check step needs a `message` - the sentence shown when the condition is false.')
        }
        break
      case 'branch':
        this.unknownKeys(raw, BRANCH_KEYS, emit, step.path)
        this.checkCondition(raw.condition, `${step.path}.condition`, scope, emit)
        if (!Array.isArray(raw.then)) {
          emit('E_FIELD_INVALID', `${step.path}.then`, 'a branch step needs `then`: the list of steps to run when the condition holds.')
        }
        if (raw.else !== undefined && !Array.isArray(raw.else)) {
          emit('E_FIELD_INVALID', `${step.path}.else`, '`else` must be a list of steps when present.')
        }
        if (step.depth > PROBE_ROUTINE_LIMITS.maxBranchDepth) {
          emit(
            'E_BRANCH_DEPTH',
            step.path,
            `branches may nest at most ${PROBE_ROUTINE_LIMITS.maxBranchDepth} deep; this branch is ${step.depth} deep (a branch inside a branch inside a branch).`,
          )
        }
        break
    }
  }

  private checkMove(
    raw: Obj,
    step: IndexedStep,
    scope: ExprNameScope,
    emit: (code: RoutineErrorCode, path: string, detail: string) => void,
  ): void {
    this.unknownKeys(raw, MOVE_KEYS, emit, step.path)
    if (raw.frame !== undefined && raw.frame !== 'start' && raw.frame !== 'machine') {
      emit('E_FIELD_INVALID', `${step.path}.frame`, `\`frame\` must be "start" (offsets from where the routine began) or "machine" (absolute); it is ${quote(raw.frame)}.`)
    }
    if (raw.feed !== undefined && raw.feed !== 'position' && raw.feed !== 'rapid') {
      emit('E_FIELD_INVALID', `${step.path}.feed`, `\`feed\` must be "position" or "rapid"; it is ${quote(raw.feed)}.`)
    }
    if (!isObj(raw.to)) {
      emit('E_FIELD_INVALID', `${step.path}.to`, `a move needs \`to\`: one to three of x, y, z, each an expression; it is ${quote(raw.to)}.`)
    } else {
      this.unknownKeys(raw.to, ['x', 'y', 'z'], emit, `${step.path}.to`)
      const axes = (['x', 'y', 'z'] as const).filter((a) => raw.to !== undefined && isObj(raw.to) && raw.to[a] !== undefined)
      if (axes.length === 0) {
        emit('E_FIELD_INVALID', `${step.path}.to`, 'a move must name at least one of x, y, z in `to`.')
      }
      for (const axis of axes) {
        this.checkExpression(raw.to[axis], `${step.path}.to.${axis}`, scope, emit, true)
      }
    }
    if (raw.safeZ !== undefined) {
      this.checkExpression(raw.safeZ, `${step.path}.safeZ`, scope, emit, false)
      if (step.number !== 1 || step.arms.length > 0) {
        emit('E_FIELD_INVALID', `${step.path}.safeZ`, '`safeZ` is only meaningful on the first step of the routine; here it would be ignored, and nothing may be silently ignored.')
      }
    }
    // WO-2073: a guarded move at the probe's search feed. WO-2088: it may travel
    // in X and/or Y as well as Z (G38.2/G38.3 take any of them); a Z-only one
    // goes down (checked on expansion).
    if (raw.stopOnContact !== undefined && typeof raw.stopOnContact !== 'boolean') {
      emit('E_FIELD_INVALID', `${step.path}.stopOnContact`, `\`stopOnContact\` must be true or false; it is ${quote(raw.stopOnContact)}.`)
    } else if (raw.stopOnContact === true) {
      if (raw.feed === 'rapid') {
        emit('E_FIELD_INVALID', `${step.path}.feed`, 'a move that stops on contact runs at the probe\'s search feed, never as a rapid.')
      }
    }
  }

  private checkTouch(
    raw: Obj,
    step: IndexedStep,
    scope: ExprNameScope,
    emit: (code: RoutineErrorCode, path: string, detail: string) => void,
  ): void {
    this.unknownKeys(raw, TOUCH_KEYS, emit, step.path)
    const axis = this.checkEnumRef(raw.axis, AXES, 'axis', `${step.path}.axis`, 'E_TOUCH_DIRECTION', emit)
    const direction = this.checkEnumRef(raw.direction, DIRECTIONS, 'direction', `${step.path}.direction`, 'E_TOUCH_DIRECTION', emit)
    const mayBeZ = axis.literal === 'Z' || (axis.options?.includes('Z') ?? false)
    const mayBePlus = direction.literal === '+' || (direction.options?.includes('+') ?? false)
    if (mayBeZ && mayBePlus) {
      emit(
        'E_TOUCH_DIRECTION',
        `${step.path}.direction`,
        axis.literal === 'Z' && direction.literal === '+'
          ? 'a Z+ touch (probing upward) is refused; an upward probe into the spindle nose is not a measurement.'
          : 'the axis and direction choices allow a Z+ touch (probing upward), which is refused; narrow the choices so Z and + cannot meet.',
      )
    }
    this.checkExpression(raw.searchMm, `${step.path}.searchMm`, scope, emit, true)
    this.checkExpression(raw.retractMm, `${step.path}.retractMm`, scope, emit, false)
    this.checkExpression(raw.backoffMm, `${step.path}.backoffMm`, scope, emit, false)
    for (const key of ['searchFeedFactor', 'finalFeedFactor'] as const) {
      const factor = raw[key]
      if (factor === undefined) continue
      const which = key === 'searchFeedFactor' ? 'search' : 'final'
      const profile = key === 'searchFeedFactor' ? this.feeds?.searchMmMin : this.feeds?.finalMmMin
      if (!isFiniteNumber(factor)) {
        emit('E_FIELD_INVALID', `${step.path}.${key}`, `\`${key}\` must be a number between 0 and 1 (a fraction of the profile's ${which} feed); it is ${quote(factor)}.`)
      } else if (factor > 1) {
        emit(
          'E_FEED_ABOVE_PROFILE',
          `${step.path}.${key}`,
          `\`${key}\` ${factor} asks for more than the profile's ${which} feed${profile !== undefined ? ` (${profile} mm/min)` : ''}. A routine may only slow a feed down (factor between 0 and 1).`,
        )
      } else if (factor <= 0) {
        emit('E_FIELD_INVALID', `${step.path}.${key}`, `\`${key}\` ${factor} would stop the probe; the factor must be greater than 0 and at most 1.`)
      }
    }
  }

  private checkCalc(
    raw: Obj,
    step: IndexedStep,
    scope: ExprNameScope,
    emit: (code: RoutineErrorCode, path: string, detail: string) => void,
  ): void {
    this.unknownKeys(raw, CALC_KEYS, emit, step.path)
    if (typeof raw.unit !== 'string' || !CALC_UNITS.includes(raw.unit)) {
      emit('E_FIELD_INVALID', `${step.path}.unit`, `a calc needs a \`unit\` of "mm", "deg", "count" or "ratio" (display only); it is ${quote(raw.unit)}.`)
    }
    const ast = this.checkExpression(raw.expr, `${step.path}.expr`, scope, emit, true)
    if (ast) {
      const divisor = findConstantZeroDivisor(ast)
      if (divisor !== null) {
        emit('E_CALC_NOT_FINITE', `${step.path}.expr`, `divides by \`${divisor}\`, which is always zero - the result can never be a number.`)
      }
    }
  }

  // -- outputs

  private checkOutputs(value: unknown): void {
    if (!Array.isArray(value)) {
      this.routineError('E_FIELD_INVALID', 'outputs', `\`outputs\` must be a list (it may be empty); it is ${quote(value)}.`)
      return
    }
    if (value.length > PROBE_ROUTINE_LIMITS.maxOutputs) {
      this.routineError('E_FIELD_INVALID', 'outputs', `a routine may propose at most ${PROBE_ROUTINE_LIMITS.maxOutputs} outputs; this one has ${value.length}.`)
    }
    const scope = this.outputScope()
    value.forEach((raw, i) => {
      const index = i + 1
      const path = `outputs[${i}]`
      if (!isObj(raw)) {
        this.outputError('E_OUTPUT_KIND', index, null, path, `an output must be an object with a \`kind\`; it is ${quote(raw)}.`)
        return
      }
      const kind = raw.kind
      const kindKnown = typeof kind === 'string' && (PROBE_ROUTINE_OUTPUT_KINDS as readonly string[]).includes(kind)
      const emit = (code: RoutineErrorCode, p: string, d: string) => this.outputError(code, index, kindKnown ? (kind as string) : null, p, d)
      if (!kindKnown) {
        emit(
          'E_OUTPUT_KIND',
          `${path}.kind`,
          kind === undefined
            ? 'the output has no `kind`. A routine can only propose a work offset, a tool length, or a report.'
            : `there is no output kind ${quote(kind)}. A routine can only propose a work offset, a tool length, or a report; it performs none of them.`,
        )
        this.scanStrings(raw, path, emit)
        return
      }
      this.scanStrings(raw, path, emit)
      switch (kind) {
        case 'workOffset': {
          this.unknownKeys(raw, WORK_OFFSET_KEYS, emit, path)
          this.checkEnumRef(raw.wcs, WCS_VALUES, 'wcs', `${path}.wcs`, 'E_FIELD_INVALID', emit)
          if (!isObj(raw.axes)) {
            emit('E_FIELD_INVALID', `${path}.axes`, `a work-offset proposal needs \`axes\`: one to three of X, Y, Z, each the machine coordinate of the new zero; it is ${quote(raw.axes)}.`)
          } else {
            this.unknownKeys(raw.axes, ['X', 'Y', 'Z'], emit, `${path}.axes`)
            const axes = (['X', 'Y', 'Z'] as const).filter((a) => isObj(raw.axes) && raw.axes[a] !== undefined)
            if (axes.length === 0) emit('E_FIELD_INVALID', `${path}.axes`, 'a work-offset proposal must name at least one of X, Y, Z.')
            for (const axis of axes) this.checkExpression(raw.axes[axis], `${path}.axes.${axis}`, scope, emit, true)
          }
          if (typeof raw.label !== 'string' || raw.label.length < 1) {
            emit('E_FIELD_INVALID', `${path}.label`, 'a work-offset proposal needs a `label`.')
          }
          if (raw.compensationNote !== undefined && typeof raw.compensationNote !== 'string') {
            emit('E_FIELD_INVALID', `${path}.compensationNote`, '`compensationNote` must be text when present.')
          }
          break
        }
        case 'toolLength': {
          this.unknownKeys(raw, TOOL_LENGTH_KEYS, emit, path)
          if (raw.tool !== 'active' && !(Number.isInteger(raw.tool) && (raw.tool as number) >= 0)) {
            emit('E_FIELD_INVALID', `${path}.tool`, `\`tool\` must be "active" or a tool number; it is ${quote(raw.tool)}.`)
          }
          this.checkExpression(raw.machineZ, `${path}.machineZ`, scope, emit, true)
          if (typeof raw.label !== 'string' || raw.label.length < 1) {
            emit('E_FIELD_INVALID', `${path}.label`, 'a tool-length proposal needs a `label`.')
          }
          break
        }
        case 'report': {
          this.unknownKeys(raw, REPORT_KEYS, emit, path)
          if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > PROBE_ROUTINE_LIMITS.maxReportItems) {
            emit('E_FIELD_INVALID', `${path}.items`, `a report needs \`items\`: 1 to ${PROBE_ROUTINE_LIMITS.maxReportItems} of { label, expr, unit }.`)
            break
          }
          raw.items.forEach((item, j) => {
            const itemPath = `${path}.items[${j}]`
            if (!isObj(item)) {
              emit('E_FIELD_INVALID', itemPath, `a report item must be { label, expr, unit }; it is ${quote(item)}.`)
              return
            }
            this.unknownKeys(item, REPORT_ITEM_KEYS, emit, itemPath)
            if (typeof item.label !== 'string' || item.label.length < 1) {
              emit('E_FIELD_INVALID', `${itemPath}.label`, 'a report item needs a `label`.')
            }
            if (typeof item.unit !== 'string' || !CALC_UNITS.includes(item.unit)) {
              emit('E_FIELD_INVALID', `${itemPath}.unit`, `a report item needs a \`unit\` of "mm", "deg", "count" or "ratio"; it is ${quote(item.unit)}.`)
            }
            this.checkExpression(item.expr, `${itemPath}.expr`, scope, emit, true)
          })
          break
        }
      }
    })
  }
}

/**
 * Validate an untrusted JSON value as a probe routine. Returns the typed
 * routine (the same object, unchanged - no defaults injected) or every error
 * found, in document order: routine, inputs, steps, outputs. Static checks
 * only (contract section 2.7); expansion and run checks live downstream.
 */
export function validateProbeRoutine(
  json: unknown,
  options: ValidateProbeRoutineOptions = {},
): ValidateProbeRoutineResult {
  const validator = new Validator(options)
  validator.validate(json)
  if (validator.errors.length > 0) return { ok: false, routine: null, errors: validator.errors }
  return { ok: true, routine: json as ProbeRoutine, errors: [] }
}

/** The sentences, one per line, ready for a list. */
export function describeRoutineErrors(errors: readonly RoutineError[]): string[] {
  return errors.map((e) => e.sentence)
}

/**
 * Canonical JSON for hashing and round-trips: keys sorted recursively, no
 * whitespace. The content hash itself (sha-256) is computed by the expander,
 * which is the only place that needs it.
 */
export function canonicalRoutineJson(routine: ProbeRoutine): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort)
    if (isObj(value)) {
      const out: Obj = {}
      for (const key of Object.keys(value).sort()) out[key] = sort(value[key])
      return out
    }
    return value
  }
  return JSON.stringify(sort(routine))
}

/** Serialize for storage or export: stable 2-space JSON in declared key order. */
export function serializeProbeRoutine(routine: ProbeRoutine): string {
  return JSON.stringify(routine, null, 2)
}

/** Parse text and validate in one step. A JSON syntax error is reported as a routine error. */
export function parseProbeRoutine(text: string, options?: ValidateProbeRoutineOptions): ValidateProbeRoutineResult {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      routine: null,
      errors: [{
        code: 'E_FIELD_INVALID',
        where: 'routine',
        step: null,
        index: null,
        path: '',
        detail: `the file is not valid JSON (${reason}).`,
        sentence: `Routine '(unreadable)': the file is not valid JSON (${reason}).`,
      }],
    }
  }
  return validateProbeRoutine(json, options)
}
