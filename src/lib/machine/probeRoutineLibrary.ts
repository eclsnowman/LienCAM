// WO-411 slice 5 - the probe routine LIBRARY model, as pure functions over a
// plain state object. The persisted store (src/store/probeRoutineStore.ts)
// holds one of these and calls these; the editor (slice 4) calls the store.
//
//   factory  - compiled in (probeRoutineFactory.ts), read-only, never stored;
//              the user may HIDE one, and "Restore factory routines" un-hides
//              every one and discards nothing of the user's.
//   user     - stored by id; a copy of a factory routine, or written here.
//   imported - stored by id; runs only after its expanded preview has been
//              reviewed once for the exact content + inputs it will run with
//              (provenance.reviewedHash === the preview hash). Any edit turns
//              it into a user routine and drops the review.
//   quarantined - a stored routine that no longer validates on load is kept
//              verbatim with its reasons (ADR-0040: no migration, no silent
//              drop); it can be exported or deleted, never run.

import {
  FACTORY_PROBE_ROUTINES,
  FACTORY_ROUTINE_ID_PREFIX,
  FACTORY_TOOL_SETTER,
  findFactoryRoutine,
  isToolSetterRoutine,
} from './probeRoutineFactory'
import {
  canonicalRoutineJson,
  validateProbeRoutine,
  type ProbeRoutine,
  type ProbeRoutineProvenanceKind,
  type RoutineError,
} from './probeRoutineFormat'

export interface QuarantinedRoutine {
  /** The stored value, verbatim. */
  json: unknown
  /** The validator's sentences, one per error. */
  errors: string[]
}

export interface ProbeRoutineLibraryState {
  /** User and imported routines, by id. Factory routines are never here. */
  routines: Record<string, ProbeRoutine>
  /** Stored routines that failed validation on load, by the id they were stored under. */
  quarantined: Record<string, QuarantinedRoutine>
  /** Factory ids the user hid from the picker. */
  hidden: string[]
}

export const EMPTY_PROBE_ROUTINE_LIBRARY: ProbeRoutineLibraryState = {
  routines: {},
  quarantined: {},
  hidden: [],
}

export interface ProbeRoutineLibraryEntry {
  routine: ProbeRoutine
  kind: ProbeRoutineProvenanceKind
  /** Only a factory routine can be hidden. */
  hidden: boolean
}

export type LibraryResult =
  | { ok: true; state: ProbeRoutineLibraryState }
  | { ok: false; state: ProbeRoutineLibraryState; errors: string[] }

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isFactoryId(id: string): boolean {
  return id.startsWith(FACTORY_ROUTINE_ID_PREFIX)
}

// --- load ----------------------------------------------------------------------

/**
 * Rebuild a library from whatever was persisted. Every stored routine is
 * re-validated; one that fails is quarantined with its sentences. Nothing is
 * dropped; nothing is migrated. A value of the wrong shape yields the empty
 * library (with the unreadable parts quarantined where an id can be found).
 */
export function loadProbeRoutineLibrary(raw: unknown): ProbeRoutineLibraryState {
  const state: ProbeRoutineLibraryState = { routines: {}, quarantined: {}, hidden: [] }
  if (!isObj(raw)) return state

  const storedQuarantine = isObj(raw.quarantined) ? raw.quarantined : {}
  for (const [id, entry] of Object.entries(storedQuarantine)) {
    if (isObj(entry) && 'json' in entry) {
      const errors = Array.isArray(entry.errors) ? entry.errors.filter((e): e is string => typeof e === 'string') : []
      state.quarantined[id] = { json: entry.json, errors }
    } else {
      state.quarantined[id] = { json: entry, errors: ['The stored quarantine record was not readable.'] }
    }
  }

  const storedRoutines = isObj(raw.routines) ? raw.routines : {}
  for (const [id, json] of Object.entries(storedRoutines)) {
    const validated = validateProbeRoutine(json)
    if (!validated.ok) {
      state.quarantined[id] = { json, errors: validated.errors.map((e: RoutineError) => e.sentence) }
      continue
    }
    const routine = validated.routine
    if (routine.id !== id) {
      state.quarantined[id] = { json, errors: [`Routine '${routine.name}': it was stored under '${id}' but its own id is '${routine.id}'.`] }
      continue
    }
    if (routine.provenance.kind === 'factory' || isFactoryId(routine.id)) {
      // never stored by construction; a factory-marked stored routine is not trusted as factory
      state.quarantined[id] = { json, errors: [`Routine '${routine.name}': a stored routine cannot be a factory routine; the factory set is compiled into LienCAM.`] }
      continue
    }
    state.routines[id] = routine
  }

  if (Array.isArray(raw.hidden)) {
    state.hidden = [...new Set(raw.hidden.filter((h): h is string => typeof h === 'string' && isFactoryId(h)))]
  }
  return state
}

// --- read ----------------------------------------------------------------------

/** Factory routines in shipped order, then user / imported sorted by name. */
export function listProbeRoutines(
  state: ProbeRoutineLibraryState,
  options: { includeHidden?: boolean } = {},
): ProbeRoutineLibraryEntry[] {
  const hidden = new Set(state.hidden)
  const factory: ProbeRoutineLibraryEntry[] = FACTORY_PROBE_ROUTINES
    .filter((r) => options.includeHidden === true || !hidden.has(r.id))
    .map((r) => ({ routine: r, kind: 'factory' as const, hidden: hidden.has(r.id) }))
  const stored: ProbeRoutineLibraryEntry[] = Object.values(state.routines)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((r) => ({ routine: r, kind: r.provenance.kind, hidden: false }))
  return [...factory, ...stored]
}

export function getProbeRoutine(state: ProbeRoutineLibraryState, id: string): ProbeRoutine | null {
  return findFactoryRoutine(id) ?? state.routines[id] ?? null
}

export function storedRoutineIds(state: ProbeRoutineLibraryState): string[] {
  return Object.keys(state.routines)
}

// --- write ---------------------------------------------------------------------

function definitionJson(routine: ProbeRoutine): string {
  return canonicalRoutineJson({ ...routine, provenance: { kind: routine.provenance.kind } })
}

/**
 * Save a user routine (new, or an edit of a user / imported one). Factory ids
 * are refused; the routine is validated; provenance becomes `user` - except
 * that saving an imported routine with its definition unchanged keeps it
 * imported (and keeps its review). Any change to an imported routine's
 * definition converts it to user and drops the reviewed-once record.
 */
export function saveProbeRoutine(state: ProbeRoutineLibraryState, input: ProbeRoutine | unknown): LibraryResult {
  const validated = validateProbeRoutine(input)
  if (!validated.ok) return { ok: false, state, errors: validated.errors.map((e) => e.sentence) }
  const candidate = validated.routine
  if (isFactoryId(candidate.id) || candidate.provenance.kind === 'factory') {
    return { ok: false, state, errors: [`Routine '${candidate.name}': the id '${candidate.id}' is reserved for the routines shipped inside LienCAM; duplicate the factory routine to edit a copy.`] }
  }
  const previous = state.routines[candidate.id]
  const unchangedImport = previous !== undefined
    && previous.provenance.kind === 'imported'
    && definitionJson(previous) === definitionJson(candidate)
  const routine: ProbeRoutine = unchangedImport
    ? { ...candidate, provenance: previous.provenance }
    : { ...candidate, provenance: { kind: 'user' } }
  const quarantined = { ...state.quarantined }
  delete quarantined[routine.id]
  return { ok: true, state: { ...state, routines: { ...state.routines, [routine.id]: routine }, quarantined } }
}

/** Store an already-imported routine (provenance forced by probeRoutineFile.importRoutines). */
export function addImportedRoutine(state: ProbeRoutineLibraryState, routine: ProbeRoutine): LibraryResult {
  if (routine.provenance.kind !== 'imported') {
    return { ok: false, state, errors: [`Routine '${routine.name}': only a routine that came through import can be stored as imported.`] }
  }
  if (isFactoryId(routine.id)) {
    return { ok: false, state, errors: [`Routine '${routine.name}': the id '${routine.id}' is reserved for the routines shipped inside LienCAM.`] }
  }
  const stored: ProbeRoutine = { ...routine, provenance: { ...routine.provenance } }
  delete stored.provenance.reviewedHash
  const quarantined = { ...state.quarantined }
  delete quarantined[stored.id]
  return { ok: true, state: { ...state, routines: { ...state.routines, [stored.id]: stored }, quarantined } }
}

/** A user copy of any routine under a fresh non-reserved id. */
export function duplicateProbeRoutine(
  state: ProbeRoutineLibraryState,
  id: string,
  options: { newId?: string; newName?: string } = {},
): LibraryResult & { id?: string } {
  const source = getProbeRoutine(state, id)
  if (source === null) return { ok: false, state, errors: [`There is no routine with id '${id}'.`] }
  const taken = new Set([...Object.keys(state.routines), ...Object.keys(state.quarantined), ...FACTORY_PROBE_ROUTINES.map((r) => r.id)])
  let newId = options.newId ?? (isFactoryId(id) ? `user.${id.slice(FACTORY_ROUTINE_ID_PREFIX.length)}` : `${id}-copy`)
  if (taken.has(newId)) {
    const base = newId
    let n = 2
    while (taken.has(`${base}-${n}`)) n++
    newId = `${base}-${n}`
  }
  const copy: ProbeRoutine = {
    ...source,
    id: newId,
    name: options.newName ?? source.name,
    provenance: { kind: 'user' },
  }
  const saved = saveProbeRoutine(state, copy)
  return saved.ok ? { ...saved, id: newId } : saved
}

/** Delete a user / imported / quarantined routine. A factory routine cannot be deleted - hide it. */
export function deleteProbeRoutine(state: ProbeRoutineLibraryState, id: string): LibraryResult {
  if (isFactoryId(id)) {
    return { ok: false, state, errors: [`Routine '${id}' is a factory routine and cannot be deleted; it can be hidden.`] }
  }
  if (!(id in state.routines) && !(id in state.quarantined)) {
    return { ok: false, state, errors: [`There is no routine with id '${id}'.`] }
  }
  const routines = { ...state.routines }
  const quarantined = { ...state.quarantined }
  delete routines[id]
  delete quarantined[id]
  return { ok: true, state: { ...state, routines, quarantined } }
}

export function hideFactoryRoutine(state: ProbeRoutineLibraryState, id: string): LibraryResult {
  if (findFactoryRoutine(id) === null) return { ok: false, state, errors: [`There is no factory routine with id '${id}'.`] }
  if (state.hidden.includes(id)) return { ok: true, state }
  return { ok: true, state: { ...state, hidden: [...state.hidden, id] } }
}

export function unhideFactoryRoutine(state: ProbeRoutineLibraryState, id: string): LibraryResult {
  return { ok: true, state: { ...state, hidden: state.hidden.filter((h) => h !== id) } }
}

/**
 * "Restore factory routines": every factory routine returns to its shipped
 * content - it was never anywhere else, the set is compiled in - and every
 * hidden one is shown again. A stored routine under a `factory.` id (none by
 * construction) is removed so the compiled one shows. User and imported
 * routines are not touched. Cannot fail: reads nothing from disk.
 */
export function restoreFactoryRoutines(state: ProbeRoutineLibraryState): ProbeRoutineLibraryState {
  const routines: Record<string, ProbeRoutine> = {}
  for (const [id, routine] of Object.entries(state.routines)) {
    if (!isFactoryId(id)) routines[id] = routine
  }
  const quarantined: Record<string, QuarantinedRoutine> = {}
  for (const [id, entry] of Object.entries(state.quarantined)) {
    if (!isFactoryId(id)) quarantined[id] = entry
  }
  return { routines, quarantined, hidden: [] }
}

// --- reviewed-once ---------------------------------------------------------------

/**
 * Record that the user reviewed the expanded preview of an imported routine.
 * `previewHash` is the expansion hash (routine content + inputs + start +
 * profile values - slice 2), so a changed routine or changed inputs is a
 * different hash and is not reviewed. Factory and user routines need no
 * review; marking one is a no-op.
 */
export function markProbeRoutineReviewed(state: ProbeRoutineLibraryState, id: string, previewHash: string): LibraryResult {
  const routine = state.routines[id]
  if (routine === undefined) {
    return findFactoryRoutine(id) !== null
      ? { ok: true, state }
      : { ok: false, state, errors: [`There is no routine with id '${id}'.`] }
  }
  if (routine.provenance.kind !== 'imported') return { ok: true, state }
  if (typeof previewHash !== 'string' || previewHash.length === 0) {
    return { ok: false, state, errors: [`Routine '${routine.name}': a review needs the preview's hash.`] }
  }
  const updated: ProbeRoutine = { ...routine, provenance: { ...routine.provenance, reviewedHash: previewHash } }
  return { ok: true, state: { ...state, routines: { ...state.routines, [id]: updated } } }
}

/** Drop the review record (the routine must be previewed again before it runs). */
export function clearProbeRoutineReview(state: ProbeRoutineLibraryState, id: string): ProbeRoutineLibraryState {
  const routine = state.routines[id]
  if (routine === undefined || routine.provenance.reviewedHash === undefined) return state
  const provenance = { ...routine.provenance }
  delete provenance.reviewedHash
  return { ...state, routines: { ...state.routines, [id]: { ...routine, provenance } } }
}

/**
 * True when the routine may run as far as the reviewed-once rule is concerned:
 * factory and user routines always; an imported routine only when its
 * recorded review matches this exact preview hash. An unknown id is false.
 */
export function isProbeRoutineReviewed(state: ProbeRoutineLibraryState, id: string, previewHash: string): boolean {
  if (findFactoryRoutine(id) !== null) return true
  const routine = state.routines[id]
  if (routine === undefined) return false
  if (routine.provenance.kind !== 'imported') return true
  return typeof previewHash === 'string' && previewHash.length > 0 && routine.provenance.reviewedHash === previewHash
}

// --- WO-1613: which routine the Measure tool button runs -----------------------

/** Every routine the Measure tool button can run: the user's and imported ones
 *  first (by name), then the factory one, which is always offered even when
 *  hidden from the picker. An imported one is offered only once reviewed. */
export function toolSetterRoutines(state: ProbeRoutineLibraryState): ProbeRoutine[] {
  const stored = Object.values(state.routines)
    .filter((r) => isToolSetterRoutine(r) && (r.provenance.kind !== 'imported' || typeof r.provenance.reviewedHash === 'string'))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return [...stored, FACTORY_TOOL_SETTER]
}

/** The one Measure tool runs unless the operator picks another: a copy the
 *  user made (their setter, their distances) before the factory routine. */
export function preferredToolSetterRoutine(state: ProbeRoutineLibraryState): ProbeRoutine {
  return toolSetterRoutines(state)[0]
}
