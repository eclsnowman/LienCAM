// WO-411 slice 5 - probe routine files: the `liencam-probe-routines` envelope
// (contract docs/research/probe-routine-format.md, part 5), export and import.
//
// Pure functions. Nothing here touches the machine, the store or the DOM.
// The store (src/store/probeRoutineStore.ts) decides what to do with the
// result; the editor (slice 4) wires the buttons.
//
// Trust rules, all enforced here and never by the file:
//   - every imported routine's provenance is FORCED to `imported`
//     (importedFrom = the file name, importedAt = now) whatever the file says;
//     the reviewed-once record is cleared on the way in;
//   - a `factory.` id never enters as factory: it is renamed `imported.<rest>`
//     and the rename is reported (E_ID_RESERVED would otherwise refuse it and
//     the contract's own round-trip - export a factory routine, import it back
//     as imported - could never work);
//   - a newer envelope `schemaVersion` refuses the WHOLE file;
//   - unknown envelope keys refuse the whole file (feeds, envelopes, offsets,
//     tool tables, results never travel);
//   - the file is bounded before it is parsed (bytes) and before it is
//     validated (nesting depth, string length, counts).

import { APP_VERSION } from '../../version'
import { sha256Hex } from './programContext'
import { FACTORY_ROUTINE_ID_PREFIX } from './probeRoutineFactory'
import {
  PROBE_ROUTINE_SCHEMA_VERSION,
  canonicalRoutineJson,
  validateProbeRoutine,
  type ProbeRoutine,
  type RoutineError,
} from './probeRoutineFormat'

export const PROBE_ROUTINE_FILE_FORMAT = 'liencam-probe-routines'
export const PROBE_ROUTINE_FILE_EXTENSION = '.liencam-probe.json'
export const IMPORTED_ROUTINE_ID_PREFIX = 'imported.'

/** Hard bounds on what a file may be before any of it is believed. */
export const PROBE_ROUTINE_FILE_LIMITS = {
  /** UTF-8 bytes of the file text. 64 routines of 64 steps fit in a fraction of this. */
  maxBytes: 1_048_576,
  /** Routines per file. */
  maxRoutines: 64,
  /** Nesting depth of arrays/objects, the envelope counted as depth 1. */
  maxDepth: 32,
  /** Characters in any one string value. */
  maxStringLength: 2_000,
  /** Keys in any one object. */
  maxObjectKeys: 64,
  /** Elements in any one array. */
  maxArrayLength: 256,
} as const

const ENVELOPE_KEYS = ['format', 'schemaVersion', 'exportedAt', 'exportedBy', 'contentHash', 'routines'] as const
const ID_RE = /^[a-z0-9][a-z0-9.-]{2,63}$/

// --- export ------------------------------------------------------------------

export interface ProbeRoutineFileEnvelope {
  format: typeof PROBE_ROUTINE_FILE_FORMAT
  schemaVersion: typeof PROBE_ROUTINE_SCHEMA_VERSION
  exportedAt: string
  exportedBy: string
  /** sha-256 of the canonical JSON of `routines`, computed by the app. Informational on the way back in. */
  contentHash: string
  routines: ProbeRoutine[]
}

export interface ExportRoutinesOptions {
  /** ISO timestamp; defaults to now. */
  now?: string
  /** Defaults to the running app's version. */
  appVersion?: string
}

/**
 * What travels (contract part 5): the definition - schemaVersion, id, name,
 * version, description, requires, inputs, steps, outputs - and the
 * provenance KIND (a factory routine stays marked factory in the file). The
 * trust fields (importedFrom / importedAt / reviewedHash) are this app's
 * record about this app's copy and do not travel.
 */
export function exportableRoutine(routine: ProbeRoutine): ProbeRoutine {
  return {
    schemaVersion: routine.schemaVersion,
    id: routine.id,
    name: routine.name,
    version: routine.version,
    provenance: { kind: routine.provenance.kind },
    description: routine.description,
    requires: routine.requires,
    inputs: routine.inputs,
    steps: routine.steps,
    outputs: routine.outputs,
  }
}

/** Content hash of a list of routines as it travels in a file. */
export function routinesContentHash(routines: readonly ProbeRoutine[]): string {
  return `sha256:${sha256Hex(`[${routines.map((r) => canonicalRoutineJson(exportableRoutine(r))).join(',')}]`)}`
}

/** Content hash of one routine's definition (provenance kind included, trust fields excluded). */
export function routineContentHash(routine: ProbeRoutine): string {
  return `sha256:${sha256Hex(canonicalRoutineJson(exportableRoutine(routine)))}`
}

export function buildProbeRoutineFile(
  routines: readonly ProbeRoutine[],
  options: ExportRoutinesOptions = {},
): ProbeRoutineFileEnvelope {
  const exportable = routines.map(exportableRoutine)
  return {
    format: PROBE_ROUTINE_FILE_FORMAT,
    schemaVersion: PROBE_ROUTINE_SCHEMA_VERSION,
    exportedAt: options.now ?? new Date().toISOString(),
    exportedBy: `LienCAM ${options.appVersion ?? APP_VERSION}`,
    contentHash: routinesContentHash(exportable),
    routines: exportable,
  }
}

/** The file text: one envelope, 2-space JSON, a trailing newline. */
export function exportRoutines(routines: readonly ProbeRoutine[], options: ExportRoutinesOptions = {}): string {
  return `${JSON.stringify(buildProbeRoutineFile(routines, options), null, 2)}\n`
}

/** `<name>.liencam-probe.json` - the routine's name slugged when there is one routine, `probe-routines` otherwise. */
export function probeRoutineFileName(routines: readonly ProbeRoutine[]): string {
  const base = routines.length === 1
    ? routines[0].name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || routines[0].id
    : 'probe-routines'
  return `${base}${PROBE_ROUTINE_FILE_EXTENSION}`
}

// --- import ------------------------------------------------------------------

/** How to treat an incoming routine whose id is already a user / imported routine. */
export type ImportCollisionPolicy = 'ask' | 'replace' | 'keep-both' | 'skip'

export interface ImportRoutinesOptions {
  /** Shown as `importedFrom`. */
  fileName: string
  /** ISO timestamp for `importedAt`; defaults to now. */
  now?: string
  /** Ids of user / imported routines already in the library. Factory ids are always known. */
  existingIds?: readonly string[]
  /** Default 'ask': a colliding routine is held in `collisions` with resolution 'pending', not accepted. */
  onCollision?: ImportCollisionPolicy
}

export interface ImportRefusedRoutine {
  /** 1-based position in the file. */
  index: number
  id: string | null
  name: string | null
  errors: RoutineError[]
  /** The sentences, one per error. */
  sentences: string[]
}

export interface ImportRename {
  index: number
  fromId: string
  toId: string
  /** Plain sentence for the report. */
  sentence: string
}

export type ImportCollisionResolution = 'pending' | 'replaced' | 'kept-both' | 'skipped'

export interface ImportCollision {
  index: number
  /** The id that collided (after any factory rename). */
  id: string
  /** The id the routine was accepted under (differs from `id` for kept-both; null when pending / skipped). */
  acceptedAs: string | null
  resolution: ImportCollisionResolution
  /** The validated incoming routine (provenance already forced), for a later decision when pending. */
  incoming: ProbeRoutine
  sentence: string
}

export interface ImportRoutinesResult {
  /** False when the whole file was refused; `fileErrors` says why and nothing else is filled. */
  ok: boolean
  fileErrors: string[]
  /** Validated routines with provenance forced to imported, ready to store. */
  accepted: ProbeRoutine[]
  refused: ImportRefusedRoutine[]
  /** `factory.` ids renamed `imported.` on the way in. */
  renamed: ImportRename[]
  collisions: ImportCollision[]
  /** Informational (a content hash that did not match, a missing timestamp ...). */
  notes: string[]
}

function refusedFile(fileErrors: string[]): ImportRoutinesResult {
  return { ok: false, fileErrors, accepted: [], refused: [], renamed: [], collisions: [], notes: [] }
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeJsonError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Walk parsed JSON and return the first bound it breaks as a sentence, or
 * null. Runs before any validation so a hostile or damaged file is refused
 * by shape alone.
 */
export function findJsonBoundViolation(
  value: unknown,
  limits: typeof PROBE_ROUTINE_FILE_LIMITS = PROBE_ROUTINE_FILE_LIMITS,
): string | null {
  const visit = (node: unknown, depth: number, path: string): string | null => {
    if (depth > limits.maxDepth) {
      return `the file nests deeper than ${limits.maxDepth} levels at ${path || 'the top'}; a routine file is never that deep.`
    }
    if (typeof node === 'string') {
      if (node.length > limits.maxStringLength) {
        return `the text at ${path} is ${node.length} characters long (limit ${limits.maxStringLength}).`
      }
      return null
    }
    if (Array.isArray(node)) {
      if (node.length > limits.maxArrayLength) {
        return `the list at ${path} has ${node.length} entries (limit ${limits.maxArrayLength}).`
      }
      for (let i = 0; i < node.length; i++) {
        const fault = visit(node[i], depth + 1, `${path}[${i}]`)
        if (fault !== null) return fault
      }
      return null
    }
    if (isObj(node)) {
      const keys = Object.keys(node)
      if (keys.length > limits.maxObjectKeys) {
        return `the object at ${path || 'the top'} has ${keys.length} fields (limit ${limits.maxObjectKeys}).`
      }
      for (const key of keys) {
        if (key.length > limits.maxStringLength) {
          return `a field name at ${path || 'the top'} is ${key.length} characters long (limit ${limits.maxStringLength}).`
        }
        const fault = visit(node[key], depth + 1, path ? `${path}.${key}` : key)
        if (fault !== null) return fault
      }
      return null
    }
    return null
  }
  return visit(value, 1, '')
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

/** Parse the envelope only (bytes, JSON, bounds, format, schemaVersion, unknown keys). */
export function parseProbeRoutineFile(
  text: string,
): { ok: true; envelope: Record<string, unknown>; routines: unknown[]; notes: string[] } | { ok: false; fileErrors: string[] } {
  const bytes = utf8Bytes(text)
  if (bytes > PROBE_ROUTINE_FILE_LIMITS.maxBytes) {
    return {
      ok: false,
      fileErrors: [`The file is ${bytes.toLocaleString('en-US')} bytes; a probe routine file is at most ${PROBE_ROUTINE_FILE_LIMITS.maxBytes.toLocaleString('en-US')} bytes. Nothing was imported.`],
    }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    return { ok: false, fileErrors: [`The file is not valid JSON (${describeJsonError(error)}). Nothing was imported.`] }
  }
  const bound = findJsonBoundViolation(json)
  if (bound !== null) return { ok: false, fileErrors: [`The file is out of bounds: ${bound} Nothing was imported.`] }
  if (!isObj(json)) {
    return { ok: false, fileErrors: [`The file is not a probe routine file: it should be an object with "format": "${PROBE_ROUTINE_FILE_FORMAT}". Nothing was imported.`] }
  }
  if (json.format !== PROBE_ROUTINE_FILE_FORMAT) {
    return {
      ok: false,
      fileErrors: [`The file is not a probe routine file: its "format" is ${json.format === undefined ? 'missing' : JSON.stringify(json.format)}, not "${PROBE_ROUTINE_FILE_FORMAT}". Nothing was imported.`],
    }
  }
  const schemaVersion = json.schemaVersion
  if (schemaVersion === undefined || !Number.isInteger(schemaVersion)) {
    return { ok: false, fileErrors: ['The file does not say which routine format it uses ("schemaVersion" is missing or not a whole number). Nothing was imported.'] }
  }
  if ((schemaVersion as number) > PROBE_ROUTINE_SCHEMA_VERSION) {
    return {
      ok: false,
      fileErrors: [`This file was saved by a newer LienCAM (format ${schemaVersion}); this version reads format ${PROBE_ROUTINE_SCHEMA_VERSION}. Nothing was imported.`],
    }
  }
  if ((schemaVersion as number) < PROBE_ROUTINE_SCHEMA_VERSION) {
    return {
      ok: false,
      fileErrors: [`This file uses routine format ${schemaVersion}; this version reads format ${PROBE_ROUTINE_SCHEMA_VERSION} and does not migrate older files. Nothing was imported.`],
    }
  }
  const unknown = Object.keys(json).filter((key) => !(ENVELOPE_KEYS as readonly string[]).includes(key))
  if (unknown.length > 0) {
    return {
      ok: false,
      fileErrors: [`The file carries ${unknown.map((k) => `"${k}"`).join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not part of a probe routine file - only routine definitions travel (no feeds, envelopes, offsets, tool tables or results), and no field may be silently ignored. Nothing was imported.`],
    }
  }
  if (!Array.isArray(json.routines)) {
    return { ok: false, fileErrors: ['The file has no "routines" list. Nothing was imported.'] }
  }
  if (json.routines.length > PROBE_ROUTINE_FILE_LIMITS.maxRoutines) {
    return { ok: false, fileErrors: [`The file lists ${json.routines.length} routines; a probe routine file holds at most ${PROBE_ROUTINE_FILE_LIMITS.maxRoutines}. Nothing was imported.`] }
  }
  const notes: string[] = []
  for (const key of ['exportedAt', 'exportedBy', 'contentHash'] as const) {
    if (json[key] !== undefined && typeof json[key] !== 'string') {
      return { ok: false, fileErrors: [`The file's "${key}" must be text when present. Nothing was imported.`] }
    }
  }
  if (json.exportedAt === undefined) notes.push('The file does not say when it was exported.')
  return { ok: true, envelope: json, routines: json.routines, notes }
}

/** `factory.<rest>` -> `imported.<rest>`; null when the result would not be a legal id. */
export function renameReservedId(id: string): string | null {
  if (!id.startsWith(FACTORY_ROUTINE_ID_PREFIX)) return id
  const renamed = `${IMPORTED_ROUTINE_ID_PREFIX}${id.slice(FACTORY_ROUTINE_ID_PREFIX.length)}`
  return ID_RE.test(renamed) ? renamed : null
}

/** `id-2`, `id-3`, ... - the first free one. */
export function keepBothId(id: string, taken: ReadonlySet<string>): string | null {
  for (let n = 2; n < 1000; n++) {
    const candidate = `${id}-${n}`
    if (!ID_RE.test(candidate)) return null
    if (!taken.has(candidate)) return candidate
  }
  return null
}

function routineError(code: RoutineError['code'], path: string, name: string | null, detail: string): RoutineError {
  return {
    code,
    where: 'routine',
    step: null,
    index: null,
    path,
    detail,
    sentence: `Routine '${name ?? '(unnamed)'}': ${detail}`,
  }
}

/**
 * Import a `liencam-probe-routines` file. Whole-file refusals come back as
 * `ok: false` with sentences; otherwise every routine is either accepted
 * (provenance forced to imported, reviewed-once cleared), refused with its
 * validator sentences, or held as a collision per `onCollision`.
 */
export function importRoutines(text: string, options: ImportRoutinesOptions): ImportRoutinesResult {
  const parsed = parseProbeRoutineFile(text)
  if (!parsed.ok) return refusedFile(parsed.fileErrors)

  const now = options.now ?? new Date().toISOString()
  const policy = options.onCollision ?? 'ask'
  // every factory id is reserved whether or not it is currently shipped: the prefix is the rule
  const existing = new Set(options.existingIds ?? [])
  const taken = new Set<string>(existing)
  const seenInFile = new Set<string>()

  const result: ImportRoutinesResult = {
    ok: true,
    fileErrors: [],
    accepted: [],
    refused: [],
    renamed: [],
    collisions: [],
    notes: [...parsed.notes],
  }

  parsed.routines.forEach((raw, i) => {
    const index = i + 1
    if (!isObj(raw)) {
      result.refused.push({
        index,
        id: null,
        name: null,
        errors: [routineError('E_FIELD_INVALID', `routines[${i}]`, null, `entry ${index} of the file is not a routine object.`)],
        sentences: [`Routine ${index} in the file is not a routine object.`],
      })
      return
    }
    const rawId = typeof raw.id === 'string' ? raw.id : null
    const rawName = typeof raw.name === 'string' ? raw.name : null

    // 1. a factory id never enters as factory
    let id = rawId
    if (rawId !== null && rawId.startsWith(FACTORY_ROUTINE_ID_PREFIX)) {
      const renamed = renameReservedId(rawId)
      if (renamed === null) {
        const detail = `the id '${rawId}' begins with 'factory.', which is reserved for the routines shipped inside LienCAM, and is too long to import under 'imported.'; it was not imported.`
        result.refused.push({ index, id: rawId, name: rawName, errors: [routineError('E_ID_RESERVED', 'id', rawName, detail)], sentences: [`Routine '${rawName ?? rawId}': ${detail}`] })
        return
      }
      id = renamed
      result.renamed.push({
        index,
        fromId: rawId,
        toId: renamed,
        sentence: `Routine '${rawName ?? rawId}': the id '${rawId}' is reserved for the routines shipped inside LienCAM; it was imported as '${renamed}'.`,
      })
    }

    // 2. provenance is the app's decision, not the file's
    const candidate: Record<string, unknown> = {
      ...raw,
      ...(id !== null ? { id } : {}),
      provenance: { kind: 'imported', importedFrom: options.fileName, importedAt: now },
    }

    // 3. validate
    const validated = validateProbeRoutine(candidate)
    if (!validated.ok) {
      result.refused.push({ index, id, name: rawName, errors: validated.errors, sentences: validated.errors.map((e) => e.sentence) })
      return
    }
    const routine = validated.routine

    // 4. the same id twice in one file
    if (seenInFile.has(routine.id)) {
      const detail = `the file lists the id '${routine.id}' more than once; only the first was imported.`
      result.refused.push({ index, id: routine.id, name: routine.name, errors: [routineError('E_FIELD_INVALID', 'id', routine.name, detail)], sentences: [`Routine '${routine.name}': ${detail}`] })
      return
    }
    seenInFile.add(routine.id)

    // 5. collision with a user / imported routine already in the library
    if (existing.has(routine.id)) {
      if (policy === 'replace') {
        result.collisions.push({ index, id: routine.id, acceptedAs: routine.id, resolution: 'replaced', incoming: routine, sentence: `Routine '${routine.name}': replaced your routine with the same id '${routine.id}'.` })
        result.accepted.push(routine)
      } else if (policy === 'keep-both') {
        const newId = keepBothId(routine.id, taken)
        if (newId === null) {
          const detail = `the id '${routine.id}' is already one of your routines and no '-2' style id was free; it was not imported.`
          result.refused.push({ index, id: routine.id, name: routine.name, errors: [routineError('E_FIELD_INVALID', 'id', routine.name, detail)], sentences: [`Routine '${routine.name}': ${detail}`] })
          return
        }
        const renamedRoutine: ProbeRoutine = { ...routine, id: newId }
        taken.add(newId)
        result.collisions.push({ index, id: routine.id, acceptedAs: newId, resolution: 'kept-both', incoming: renamedRoutine, sentence: `Routine '${routine.name}': the id '${routine.id}' is already one of your routines; the import was kept as '${newId}'.` })
        result.accepted.push(renamedRoutine)
      } else if (policy === 'skip') {
        result.collisions.push({ index, id: routine.id, acceptedAs: null, resolution: 'skipped', incoming: routine, sentence: `Routine '${routine.name}': the id '${routine.id}' is already one of your routines; the import was skipped.` })
      } else {
        result.collisions.push({ index, id: routine.id, acceptedAs: null, resolution: 'pending', incoming: routine, sentence: `Routine '${routine.name}': the id '${routine.id}' is already one of your routines. Replace it, keep both, or skip this one?` })
      }
      return
    }

    taken.add(routine.id)
    result.accepted.push(routine)
  })

  const claimed = parsed.envelope.contentHash
  if (typeof claimed === 'string') {
    const exportable = parsed.routines.filter(isObj)
    // recompute over the file's own routine objects as written (definition + kind), not the forced ones
    const actual = (() => {
      try {
        return routinesContentHash(exportable as unknown as ProbeRoutine[])
      } catch {
        return null
      }
    })()
    if (actual !== claimed) {
      result.notes.push('The file\'s content hash does not match its routines - the file was edited or damaged after it was exported. The routines were read from the contents; review each before its first run.')
    }
  }

  return result
}

/**
 * Settle one pending collision after the user answered. Returns the routine
 * to store (under the id it should be stored as) or null for skip.
 */
export function resolveImportCollision(
  collision: ImportCollision,
  decision: Exclude<ImportCollisionPolicy, 'ask'>,
  existingIds: readonly string[],
): { routine: ProbeRoutine; replaced: boolean } | null {
  if (decision === 'skip') return null
  if (decision === 'replace') return { routine: collision.incoming, replaced: true }
  const newId = keepBothId(collision.id, new Set(existingIds))
  if (newId === null) return null
  return { routine: { ...collision.incoming, id: newId }, replaced: false }
}
