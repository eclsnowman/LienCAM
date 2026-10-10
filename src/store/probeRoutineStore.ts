import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
// probeRoutineStore - persisted user-space library of probe routines
// (WO-411 slices 4/5; contract docs/research/probe-routine-format.md part 5).
//
// Holds user and imported routines, the quarantine, and the hidden factory
// ids. Factory routines come from probeRoutineFactory.ts and are NEVER stored.
// Every rule lives in the pure model (src/lib/machine/probeRoutineLibrary.ts)
// and the file module (src/lib/machine/probeRoutineFile.ts); this store only
// persists a library state through the registered key and exposes actions.
// Nothing here moves the machine.

import { create } from 'zustand'
import { persistRegistered } from './persistedKeys'
import {
  exportRoutines,
  importRoutines,
  probeRoutineFileName,
  resolveImportCollision,
  type ImportCollision,
  type ImportCollisionPolicy,
  type ImportRoutinesResult,
} from '../lib/machine/probeRoutineFile'
import {
  EMPTY_PROBE_ROUTINE_LIBRARY,
  addImportedRoutine,
  clearProbeRoutineReview,
  deleteProbeRoutine,
  duplicateProbeRoutine,
  getProbeRoutine,
  hideFactoryRoutine,
  isProbeRoutineReviewed,
  listProbeRoutines,
  loadProbeRoutineLibrary,
  markProbeRoutineReviewed,
  restoreFactoryRoutines,
  saveProbeRoutine,
  unhideFactoryRoutine,
  type ProbeRoutineLibraryEntry,
  type ProbeRoutineLibraryState,
} from '../lib/machine/probeRoutineLibrary'
import type { ProbeRoutine } from '../lib/machine/probeRoutineFormat'

export interface ProbeRoutineActionResult {
  ok: boolean
  errors: string[]
}

export interface ProbeRoutineStoreState extends ProbeRoutineLibraryState {
  /** Factory (minus hidden unless asked), then user / imported by name. */
  listRoutines: (options?: { includeHidden?: boolean }) => ProbeRoutineLibraryEntry[]
  getRoutine: (id: string) => ProbeRoutine | null
  /** Save a user routine or an edit; editing an imported routine converts it to user. */
  saveRoutine: (routine: ProbeRoutine | unknown) => ProbeRoutineActionResult
  duplicateRoutine: (id: string, options?: { newId?: string; newName?: string }) => ProbeRoutineActionResult & { id?: string }
  deleteRoutine: (id: string) => ProbeRoutineActionResult
  hideFactoryRoutine: (id: string) => ProbeRoutineActionResult
  unhideFactoryRoutine: (id: string) => ProbeRoutineActionResult
  /** Every factory routine back to its shipped content and visible; user / imported untouched. */
  restoreFactoryRoutines: () => void

  /** Reviewed-once: record a review of an imported routine's expanded preview. */
  markReviewed: (id: string, previewHash: string) => ProbeRoutineActionResult
  clearReview: (id: string) => void
  isReviewed: (id: string, previewHash: string) => boolean

  /** The file text for these ids (factory included, still marked factory in the file). */
  exportRoutines: (ids: readonly string[]) => { ok: true; text: string; fileName: string } | { ok: false; errors: string[] }
  /** Import a file; accepted routines are stored as imported. Collisions follow `onCollision` (default 'ask' - held, not stored). */
  importFromText: (text: string, fileName: string, onCollision?: ImportCollisionPolicy) => ImportRoutinesResult
  /** Settle one collision the user was asked about. */
  resolveCollision: (collision: ImportCollision, decision: Exclude<ImportCollisionPolicy, 'ask'>) => ProbeRoutineActionResult
}

function libraryOf(state: ProbeRoutineStoreState): ProbeRoutineLibraryState {
  return { routines: state.routines, quarantined: state.quarantined, hidden: state.hidden }
}

export const useProbeRoutineStore = create<ProbeRoutineStoreState>()(
  persistRegistered('probeRoutines',
    (set, get) => {
      const apply = (result: { ok: boolean; state: ProbeRoutineLibraryState; errors?: string[] }): ProbeRoutineActionResult => {
        if (result.ok) set(result.state)
        return { ok: result.ok, errors: result.errors ?? [] }
      }
      return {
        ...EMPTY_PROBE_ROUTINE_LIBRARY,

        listRoutines: (options) => listProbeRoutines(libraryOf(get()), options),
        getRoutine: (id) => getProbeRoutine(libraryOf(get()), id),
        saveRoutine: (routine) => apply(saveProbeRoutine(libraryOf(get()), routine)),
        duplicateRoutine: (id, options) => {
          const result = duplicateProbeRoutine(libraryOf(get()), id, options)
          const applied = apply(result)
          return result.ok ? { ...applied, id: result.id } : applied
        },
        deleteRoutine: (id) => apply(deleteProbeRoutine(libraryOf(get()), id)),
        hideFactoryRoutine: (id) => apply(hideFactoryRoutine(libraryOf(get()), id)),
        unhideFactoryRoutine: (id) => apply(unhideFactoryRoutine(libraryOf(get()), id)),
        restoreFactoryRoutines: () => set(restoreFactoryRoutines(libraryOf(get()))),

        markReviewed: (id, previewHash) => apply(markProbeRoutineReviewed(libraryOf(get()), id, previewHash)),
        clearReview: (id) => set(clearProbeRoutineReview(libraryOf(get()), id)),
        isReviewed: (id, previewHash) => isProbeRoutineReviewed(libraryOf(get()), id, previewHash),

        exportRoutines: (ids) => {
          const library = libraryOf(get())
          const routines: ProbeRoutine[] = []
          const errors: string[] = []
          for (const id of ids) {
            const routine = getProbeRoutine(library, id)
            if (routine === null) errors.push(operatorText('probeRoutineStore1', { value1: String(id) }))
            else routines.push(routine)
          }
          if (errors.length > 0) return { ok: false, errors }
          if (routines.length === 0) return { ok: false, errors: [operatorText('probeRoutineStore2')] }
          return { ok: true, text: exportRoutines(routines), fileName: probeRoutineFileName(routines) }
        },

        importFromText: (text, fileName, onCollision = 'ask') => {
          const before = libraryOf(get())
          const result = importRoutines(text, {
            fileName,
            existingIds: Object.keys(before.routines),
            onCollision,
          })
          if (!result.ok) return result
          let library = before
          for (const routine of result.accepted) {
            const added = addImportedRoutine(library, routine)
            if (added.ok) library = added.state
            else {
              result.refused.push({ index: 0, id: routine.id, name: routine.name, errors: [], sentences: added.errors })
            }
          }
          set(library)
          return result
        },

        resolveCollision: (collision, decision) => {
          const library = libraryOf(get())
          const settled = resolveImportCollision(collision, decision, Object.keys(library.routines))
          if (settled === null) return { ok: true, errors: [] }
          return apply(addImportedRoutine(library, settled.routine))
        },
      }
    },
    {
      version: 1,
      partialize: (state) => ({
        routines: state.routines,
        quarantined: state.quarantined,
        hidden: state.hidden,
      }) as unknown as ProbeRoutineStoreState,
      // Every stored routine is re-validated on load; one that no longer
      // validates is quarantined with its reasons (ADR-0040: no migration,
      // nothing silently dropped).
      merge: (persisted, current) => ({ ...current, ...loadProbeRoutineLibrary(persisted) }),
    },
  ),
)
