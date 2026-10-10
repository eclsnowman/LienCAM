import type {
  PostCapabilities,
  PostConfig,
  PostOptions,
  ProgramEndMode,
} from './types'
import {
  genericGcodeWordTable,
  spellGcodeWord,
  type GcodeTableDialect,
  type GcodeWordCategory,
  type GcodeWordEntry,
  type GcodeWordTable,
} from '../gcode/wordTable'

export type OriginalVendorPost = { filename: string; bytesBase64: string }
export type UserPostConfig = PostConfig & {
  wordTable: GcodeWordTable
  originalVendorPost?: OriginalVendorPost
}

export type UserPostImportResult =
  | { ok: true; config: UserPostConfig }
  | { ok: false; error: string }

const WORD_CATEGORIES: readonly GcodeWordCategory[] = [
  'motion',
  'canned cycle',
  'dwell',
  'plane',
  'units',
  'cutter compensation',
  'tool length offset',
  'work offset',
  'offset write',
  'machine frame',
  'home',
  'reference point',
  'probe',
  'path control',
  'distance mode',
  'arc-centre mode',
  'feed-rate mode',
  'canned-cycle return',
  'program flow',
  'spindle',
  'tool change',
  'coolant',
  'output',
]

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must be a non-empty string`)
  }
  return value
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be true or false`)
  return value
}

function finiteNumber(value: unknown, path: string, min?: number, max?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`)
  }
  if (min !== undefined && value < min) throw new Error(`${path} must be >= ${min}`)
  if (max !== undefined && value > max) throw new Error(`${path} must be <= ${max}`)
  return value
}

function optionalNumber(value: unknown, path: string, min?: number): number | undefined {
  return value === undefined ? undefined : finiteNumber(value, path, min)
}

function choice<T extends string>(value: unknown, path: string, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) {
    throw new Error(`${path} must be one of: ${choices.join(', ')}`)
  }
  return value as T
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${path} must be an array of strings`)
  }
  return [...value]
}

function nullableText(value: unknown, path: string): string | null {
  if (value === null) return null
  return text(value, path)
}

function originalVendorPost(value: unknown): OriginalVendorPost | undefined {
  if (value === undefined) return undefined
  const raw = record(value, 'originalVendorPost')
  const filename = text(raw.filename, 'originalVendorPost.filename')
  if (typeof raw.bytesBase64 !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.bytesBase64)) {
    throw new Error('originalVendorPost.bytesBase64 must contain base64 bytes')
  }
  return { filename, bytesBase64: raw.bytesBase64 }
}

/** Decode bytes, never text, so browser and desktop saves preserve the source. */
export function originalVendorPostFile(config: PostConfig): { filename: string; contents: Blob } | undefined {
  const original = (config as Partial<UserPostConfig>).originalVendorPost
  if (!original) return undefined
  const bytes = Uint8Array.from(atob(original.bytesBase64), (char) => char.charCodeAt(0))
  return { filename: original.filename, contents: new Blob([bytes], { type: 'application/octet-stream' }) }
}

function readerDialect(capabilities: PostCapabilities): GcodeTableDialect {
  return capabilities.dwellUnits === 'ms' ? 'uccnc' : 'grbl'
}

function wordTableEntry(value: unknown, path: string): GcodeWordEntry {
  const raw = record(value, path)
  const letter = choice(raw.letter, `${path}.letter`, ['G', 'M'] as const)
  const number = finiteNumber(raw.value, `${path}.value`, 0)
  if (spellGcodeWord(letter, number) !== text(raw.word, `${path}.word`).toUpperCase()) {
    throw new Error(`${path}.word must match letter and value`)
  }
  return {
    word: spellGcodeWord(letter, number),
    letter,
    value: number,
    category: choice(raw.category, `${path}.category`, WORD_CATEGORIES),
    modalGroup: nullableText(raw.modalGroup, `${path}.modalGroup`),
    meaning: text(raw.meaning, `${path}.meaning`).trim(),
  }
}

function importedWordTable(
  value: unknown,
  label: string,
  capabilities: PostCapabilities,
): GcodeWordTable {
  const dialect = readerDialect(capabilities)
  if (value === undefined) return genericGcodeWordTable(label, dialect)

  const raw = record(value, 'wordTable')
  if (!Array.isArray(raw.entries)) throw new Error('wordTable.entries must be an array')
  const entries = raw.entries.map((item, index) => wordTableEntry(item, `wordTable.entries[${index}]`))
    .sort((a, b) => (a.letter === b.letter ? a.value - b.value : a.letter < b.letter ? -1 : 1))
  const seen = new Set<string>()
  for (const item of entries) {
    if (seen.has(item.word)) throw new Error(`wordTable.entries contains ${item.word} more than once`)
    seen.add(item.word)
  }

  let macroMCodes: GcodeWordTable['macroMCodes'] = null
  if (raw.macroMCodes !== undefined && raw.macroMCodes !== null) {
    const range = record(raw.macroMCodes, 'wordTable.macroMCodes')
    const from = finiteNumber(range.from, 'wordTable.macroMCodes.from', 0)
    if (!Number.isInteger(from)) throw new Error('wordTable.macroMCodes.from must be an integer')
    const to = range.to === null
      ? null
      : finiteNumber(range.to, 'wordTable.macroMCodes.to', from)
    if (to !== null && !Number.isInteger(to)) {
      throw new Error('wordTable.macroMCodes.to must be an integer or null')
    }
    macroMCodes = { from, to }
  }

  return { dialect, label, entries, macroMCodes }
}

/** Give a saved post the reader half of its controller definition. Posts made
 *  before this field existed receive the generic table, per ADR-0040: this is
 *  the current portable shape, not a stored-project migration. */
export function withUserPostWordTable(config: PostConfig): UserPostConfig {
  const carried = (config as Partial<UserPostConfig>).wordTable
  return {
    ...config,
    wordTable: carried
      ? { ...structuredClone(carried), label: config.label }
      : genericGcodeWordTable(config.label, readerDialect(config.capabilities)),
  }
}

/**
 * Parse a portable, declarative LienCAM post definition. Imported files never
 * execute code: fields are copied into PostConfig only after a full shape and
 * range check, and imported definitions never receive built-in authority.
 */
export function parseUserPostConfig(source: string): UserPostImportResult {
  try {
    const root = record(JSON.parse(source) as unknown, 'post')
    const capabilitiesRaw = record(root.capabilities, 'capabilities')
    const offsetsRaw = record(capabilitiesRaw.workOffsets, 'capabilities.workOffsets')
    const formatRaw = record(root.format, 'format')
    const framingRaw = record(root.framing, 'framing')
    const optionsRaw = record(root.options, 'options')

    for (const [key, value] of Object.entries(optionsRaw)) {
      if (!['string', 'number', 'boolean', 'undefined'].includes(typeof value)) {
        throw new Error(`options.${key} must be a string, number, or boolean`)
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new Error(`options.${key} must be a finite number`)
      }
    }

    const capabilities: PostCapabilities = {
      arcs: bool(capabilitiesRaw.arcs, 'capabilities.arcs'),
      arcFullCircle: bool(capabilitiesRaw.arcFullCircle, 'capabilities.arcFullCircle'),
      arcCenterMode: choice(capabilitiesRaw.arcCenterMode, 'capabilities.arcCenterMode', ['ijk', 'r']),
      cannedCycles: bool(capabilitiesRaw.cannedCycles, 'capabilities.cannedCycles'),
      toolChange: choice(capabilitiesRaw.toolChange, 'capabilities.toolChange', ['m6', 'pause', 'none', 'macro']),
      workOffsets: {
        g54_59: bool(offsetsRaw.g54_59, 'capabilities.workOffsets.g54_59'),
        extended: bool(offsetsRaw.extended, 'capabilities.workOffsets.extended'),
        g10: bool(offsetsRaw.g10, 'capabilities.workOffsets.g10'),
      },
      feedMode: choice(capabilitiesRaw.feedMode, 'capabilities.feedMode', ['g94', 'g93-supported']),
      comment: choice(capabilitiesRaw.comment, 'capabilities.comment', ['paren', 'semicolon']),
      minArcRadius: finiteNumber(capabilitiesRaw.minArcRadius, 'capabilities.minArcRadius', 0),
      maxArcRadius: optionalNumber(capabilitiesRaw.maxArcRadius, 'capabilities.maxArcRadius', 0),
      minSweepDeg: optionalNumber(capabilitiesRaw.minSweepDeg, 'capabilities.minSweepDeg', 0),
      maxLineLength: optionalNumber(capabilitiesRaw.maxLineLength, 'capabilities.maxLineLength', 0),
      dwellUnits: choice(capabilitiesRaw.dwellUnits, 'capabilities.dwellUnits', ['ms', 's']),
    }

    const programEndMode = choice<ProgramEndMode>(
      optionsRaw.programEndMode,
      'options.programEndMode',
      ['safe_z_only', 'machine_coords', 'home', 'custom'],
    )
    const options: PostOptions = {
      ...(optionsRaw as PostOptions),
      programEndMode,
      writeWorkOffsets: bool(optionsRaw.writeWorkOffsets, 'options.writeWorkOffsets'),
    }

    const id = text(root.id, 'id')
    const label = text(root.label, 'label').trim()
    const config: UserPostConfig = {
      id,
      label,
      builtin: false,
      capabilities,
      format: {
        xyzDecimals: finiteNumber(formatRaw.xyzDecimals, 'format.xyzDecimals', 0, 8),
        feedDecimals: finiteNumber(formatRaw.feedDecimals, 'format.feedDecimals', 0, 8),
        units: choice(formatRaw.units, 'format.units', ['mm', 'inch']),
        lineNumbers: bool(formatRaw.lineNumbers, 'format.lineNumbers'),
        lineNumberStep: finiteNumber(formatRaw.lineNumberStep, 'format.lineNumberStep', 0, 1000),
      },
      framing: {
        programStart: stringArray(framingRaw.programStart, 'framing.programStart'),
        programEnd: stringArray(framingRaw.programEnd, 'framing.programEnd'),
        sectionComment: bool(framingRaw.sectionComment, 'framing.sectionComment'),
      },
      options,
      wordTable: importedWordTable(root.wordTable, label, capabilities),
      ...(root.originalVendorPost === undefined ? {} : { originalVendorPost: originalVendorPost(root.originalVendorPost) }),
    }

    if (
      config.capabilities.maxArcRadius !== undefined
      && config.capabilities.maxArcRadius < config.capabilities.minArcRadius
    ) {
      return { ok: false, error: 'capabilities.maxArcRadius must be >= minArcRadius' }
    }
    return { ok: true, config }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Post definition is invalid',
    }
  }
}

/**
 * Serialize the live editor state to the same declarative schema accepted by
 * parseUserPostConfig. Built-in authority is deliberately stripped before the
 * round-trip validation so a shared built-in template always imports as a
 * normal user-owned definition.
 */
export function serializeUserPostConfig(config: PostConfig): string {
  const normalized = withUserPostWordTable(structuredClone(config))
  const portable = {
    ...normalized,
    builtin: false,
    wordTable: {
      entries: normalized.wordTable.entries,
      macroMCodes: normalized.wordTable.macroMCodes,
    },
  }
  const source = `${JSON.stringify(portable, null, 2)}\n`
  const validation = parseUserPostConfig(source)
  if (!validation.ok) {
    throw new Error(`Post definition is not portable: ${validation.error}`)
  }
  return source
}

/**
 * Build a filesystem-safe portable-definition filename from the visible post
 * label. The suffix is fixed so the Post Process import picker recognizes the
 * downloaded artifact without asking the user to rename it.
 */
export function userPostDefinitionFilename(config: PostConfig): string {
  const withoutKnownSuffix = config.label.trim().replace(/\.lienpost\.json$/i, '')
  let stem = withoutKnownSuffix
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80)
    .replace(/[._-]+$/g, '')

  if (!stem) stem = 'LienCAM_post'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) {
    stem = `LienCAM_${stem}`
  }
  return `${stem}.lienpost.json`
}
