// WO-1818: one registry classifies every persisted surface.
//
// WHY THIS EXISTS. docs/ARCHITECTURE-AUDIT-2026-08-26.md section 3.7 found ten
// persisted surfaces and, for the biggest one (the project document), two
// independently-maintained keep-lists: persistPartialize (store/index.ts, the
// localStorage/userSpace rehydrate leg) and saveProjectToFile/
// packageProjectToFile (store/index.ts, the .camproject file leg) each hand-
// picked which top-level Project fields to strip. They disagreed by
// construction, and the disagreement has already shipped a real defect:
// Operation.contourTabPreview rode into BOTH persisted forms untouched while
// its sibling derived fields (toolpathMoves, nest compute-state) were
// stripped from localStorage - see src/tests/store/setupClosureCensus.ts:130,
// now resolved below.
//
// WHAT THIS FILE DOES. `PROJECT_FIELD_TREATMENT` names every top-level
// `Project` field exactly once (`Record<keyof Project, ProjectFieldTreatment>`
// - an exhaustive mapped type, not a hand-checked list: TypeScript refuses to
// compile this file if a field is added to `Project` and left out here, or if
// a stale field is left behind after one is removed). `persistPartialize` and
// `packageProjectToFile` (store/index.ts) both strip the surfaces classified
// `holder-owned` through the ONE shared `omitProjectFields` call below, and
// both strip the two derived Operation fields through the ONE shared
// `stripOperationForPersistence` call - so "which keep-list wins" stops being
// a question two separately-maintained call sites can answer differently.
//
// `PERSISTED_SURFACES` covers the other nine surfaces the audit named
// (the three machine-scoped stores, uiPrefs, the IndexedDB caches, the
// userSpace envelope): each entry names its version (or states it has none)
// and its migration/mismatch policy, so a version mismatch is a documented
// decision, not a silent guess.
//
// OUT OF SCOPE (WO-1818): store seams (WO-1823); any behaviour change to what
// a field MEANS. `binaries` and nest compute-state (status/error/
// computeStartedAt) keep their existing, already-asymmetric treatment between
// the two Project-document legs - documented below, not touched - because
// unifying them would change what ships in a saved file, which this WO does
// not extend to.

import type { Operation, Project } from '../types'

// ---- The one Project-document keep-list ------------------------------------

/**
 * How a top-level `Project` field is treated across the two Project-document
 * persistence legs (localStorage/userSpace rehydrate vs. the saved
 * `.camproject` file):
 *  - 'core': copied verbatim into both legs from the live project.
 *  - 'root-lifted': NOT trusted from the live project - a root store slice
 *    (`toolLibrary`/`toolLibraries`/`holders`) is the authority. Zeroed on the
 *    project value itself in both legs; each leg independently derives its
 *    own copy (the root slice for localStorage, a lean per-file subset via
 *    `gatherUsedTools`/`gatherUsedToolLibraries`/`gatherUsedHolders` for the
 *    file) - two DIFFERENT values by design, not a keep-list disagreement.
 *  - 'localstorage-heavy': the full value ships in the saved file; a named,
 *    nested payload is trimmed from the localStorage rehydrate blob only
 *    (headroom against the ~5MB quota, D-014) and is cheaply re-derived
 *    on demand (Regen / a workspace remount). See the field's own comment
 *    below for which nested payload and where it is re-derived.
 *  - 'holder-owned': NEVER trusted from the live project object - the
 *    document/model holder (`documentHolder.ts`) is the sole source of
 *    truth. Stripped from the live project via `omitProjectFields` before
 *    EITHER persisted form is built; each leg then independently decides
 *    whether to re-derive a fresh copy (the file leg does, from the holder;
 *    the localStorage leg omits it outright - the holder is durable on its
 *    own IndexedDB axis, not localStorage's).
 */
export type ProjectFieldTreatment =
  | 'core'
  | 'root-lifted'
  | 'localstorage-heavy'
  | 'holder-owned'

/**
 * Exhaustive by construction: `Record<keyof Project, ProjectFieldTreatment>`
 * requires one entry per CURRENT `Project` field and rejects any field this
 * table no longer names. Add a field to `Project` (src/types/index.ts) without
 * adding it here and `npm run build` (`tsc -b`) fails on this literal before
 * it ever reaches a browser - the WO-1818 acceptance's "adding a field forces
 * a classification at compile time" made real, not aspirational.
 */
export const PROJECT_FIELD_TREATMENT: Record<keyof Project, ProjectFieldTreatment> = {
  id: 'core',
  name: 'core',
  version: 'core',
  schemaVersion: 'core',
  createdAt: 'core',
  updatedAt: 'core',
  machine: 'core',
  toolLibrary: 'root-lifted',
  toolLibraries: 'root-lifted',
  holders: 'root-lifted',
  // geometry: the file keeps each modeled body's full display tessellation;
  // persistPartialize replaces `modelBody.display` with just its `ref` for
  // the localStorage blob (store/index.ts persistPartialize, the
  // `geometry.map` call). Re-derived on demand from the IndexedDB
  // modelBodyDisplayCache (see PERSISTED_SURFACES['model-body-display-cache'])
  // or, failing that, restoreGeometryToViewport's regen path.
  geometry: 'localstorage-heavy',
  geometryFolders: 'core',
  modelItems: 'core',
  modelItemPlacements: 'core',
  // Full original bytes travel in .camproject; localStorage keeps metadata
  // only, with bytes restored from the project/image-scoped IndexedDB cache.
  referenceImages2d: 'localstorage-heavy',
  // setups: nests the two Operation fields stripOperationForPersistence
  // classifies below (toolpathMoves, contourTabPreview) - the OTHER half of
  // this WO's "one keep-list", one level down from the Project record itself.
  setups: 'localstorage-heavy',
  activeSetupId: 'core',
  activeOperationId: 'core',
  sceneStock: 'core',
  stocks: 'core',
  // nests: persistPartialize strips the transient status/error/
  // computeStartedAt trio (store/index.ts, the `nests.map` call) so a reload
  // never resurrects a stale 'computing'/error state the worker that owned it
  // is gone. The saved FILE currently keeps these fields as-is - an existing
  // asymmetry this WO does not extend to (out of scope: no behaviour change
  // to what a field means). Named here rather than left undiscovered.
  nests: 'localstorage-heavy',
  // binaries: persistPartialize drops it outright (IndexedDB is the durable
  // home for the bytes it represents); packageProjectToFile always re-derives
  // it fresh from collectProjectBinaries over the project's geometry rather than
  // trusting any copy riding on the live project object. Kept as its own
  // explicit strip in each leg (not merged into the shared
  // `omitProjectFields` call) - see the file's top-of-file OUT OF SCOPE note.
  binaries: 'holder-owned',
  document: 'holder-owned',
  modelItemDocuments: 'holder-owned',
  notes: 'core',
  fonts: 'core',
  // WO-2167: the workholding definitions + instances - plain data, saved as-is.
  workholding: 'core',
  // WO-2637: per-program tool numbers chosen on the Post Process screen -
  // plain data, saved as-is in both legs.
  postToolNumbers: 'core',
}

function fieldsWithTreatment<T extends ProjectFieldTreatment>(treatment: T): (keyof Project)[] {
  return (Object.keys(PROJECT_FIELD_TREATMENT) as (keyof Project)[])
    .filter((field) => PROJECT_FIELD_TREATMENT[field] === treatment)
}

/** Every field classified 'root-lifted' - documentation/introspection only
 *  (UserDataStoragePanel, a future census); nothing in store/index.ts reads
 *  this yet, since each 'root-lifted' field is already independently
 *  recomputed per leg rather than stripped via a shared omit call. */
export const PROJECT_ROOT_LIFTED_FIELDS: readonly (keyof Project)[] = fieldsWithTreatment('root-lifted')

/**
 * The 'holder-owned' fields BOTH Project-document legs strip identically from
 * the raw live-project copy before building their own persisted form
 * (`document`, `modelItemDocuments` - see PROJECT_FIELD_TREATMENT). `binaries`
 * is 'holder-owned' too but keeps its own per-leg strip (see that field's
 * comment) rather than joining this shared list, so this constant names only
 * the two fields whose raw-copy handling is genuinely identical today.
 */
export const PROJECT_HOLDER_OWNED_RAW_STRIP_FIELDS = ['document', 'modelItemDocuments'] as const

/** A shallow copy of `project` with every field in `fields` removed. The one
 *  place persistPartialize and packageProjectToFile (store/index.ts) both
 *  drop the project's own copy of a holder-owned field before either builds
 *  its persisted snapshot. */
export function omitProjectFields<K extends keyof Project>(
  project: Project,
  fields: readonly K[],
): Omit<Project, K> {
  const clone: Project = { ...project }
  for (const field of fields) delete clone[field]
  return clone as Omit<Project, K>
}

// ---- The one Operation derived-field keep-list -----------------------------

/**
 * How a dispatch-derived (never user-authored) `Operation` field is treated
 * across the two Project-document persistence legs:
 *  - 'localstorage-only-strip': the saved FILE keeps the real value (it is
 *    what makes a saved file an actually-cuttable toolpath); the localStorage
 *    rehydrate blob drops it (too heavy for the ~5MB quota) and
 *    reconcileLoadedOpLifecycle (store/index.ts) downgrades the op's status
 *    on the next load so a reload never shows a stale 'ready' with no moves.
 *  - 'always-strip': a UI-marker-only derivation with zero recompute cost
 *    (computed alongside its owning op's real compute, off already-resolved
 *    data) and no load-path consumer that trusts it without a presence guard.
 *    Dropped from EVERY persisted form; the next contour compute re-derives
 *    it. WO-1818: this is contourTabPreview's fix for
 *    src/tests/store/setupClosureCensus.ts:130's now-resolved FINDING.
 */
export type OperationPersistedFieldTreatment =
  | 'localstorage-only-strip'
  | 'always-strip'

export const OPERATION_PERSISTED_FIELD_TREATMENT: Record<
  'toolpathMoves' | 'contourTabPreview',
  OperationPersistedFieldTreatment
> = {
  toolpathMoves: 'localstorage-only-strip',
  contourTabPreview: 'always-strip',
}

export type PersistenceTarget = 'localstorage' | 'file'

/** The ONE function persistPartialize (target 'localstorage') and
 *  packageProjectToFile (target 'file') both call to strip an operation's
 *  derived fields for persistence - the fix for the two-keep-lists defect
 *  this WO exists to close (WO-1818 acceptance #2/#3). Pure: returns a new
 *  object, never mutates `op`. */
export function stripOperationForPersistence(op: Operation, target: PersistenceTarget): Operation {
  const result: Operation = { ...op }
  for (const key of Object.keys(OPERATION_PERSISTED_FIELD_TREATMENT) as
    (keyof typeof OPERATION_PERSISTED_FIELD_TREATMENT)[]) {
    const treatment = OPERATION_PERSISTED_FIELD_TREATMENT[key]
    if (treatment === 'always-strip' || (treatment === 'localstorage-only-strip' && target === 'localstorage')) {
      delete result[key]
    }
  }
  return result
}

// ---- Catalogued user data the store carries as plain data ------------------

/**
 * WO-2643: root keys the shop-data catalogue (userSpaceStorage.ts
 * PERSISTED_COLLECTIONS: recipe templates, cutting data, fixtures) lists and a
 * restore brings in, but that no screen edits yet. The store carries each one
 * verbatim - persistMerge keeps it, persistPartialize writes it back - so the
 * next save after a restore cannot drop what the restore showed. A profile
 * that never held one stays without it (undefined is never written).
 */
export const CARRIED_USER_DATA_KEYS = [
  'operationTemplates',
  'setupTemplates',
  'recipeTemplates',
  'materialPresets',
  'cuttingDataPresets',
  'fixtures',
  'spoilboards',
  'vises',
] as const

export type CarriedUserData = Partial<Record<(typeof CARRIED_USER_DATA_KEYS)[number], unknown>>

/** The carried keys `source` holds a value for, and nothing else. */
export function pickCarriedUserData(source: object | null | undefined): CarriedUserData {
  const picked: CarriedUserData = {}
  if (!source) return picked
  for (const key of CARRIED_USER_DATA_KEYS) {
    const value = (source as CarriedUserData)[key]
    if (value !== undefined) picked[key] = value
  }
  return picked
}

// ---- Every OTHER persisted surface -----------------------------------------

export type PersistedSurfaceId =
  | 'project-document'
  | 'ui-preferences'
  | 'machine-actions'
  | 'machine-tool-table-legacy'
  | 'probe-routines'
  | 'model-body-display-cache'
  | 'user-space-envelope'

export interface PersistedSurface {
  id: PersistedSurfaceId
  /** Where the bytes actually live. */
  medium: 'zustand-persist-localstorage' | 'zustand-persist-userspace' | 'indexeddb'
  /** The version field/constant that guards this surface, or an explicit
   *  statement that it has none. */
  version: string
  /** What runs (or is deliberately skipped) when the stored version differs
   *  from current - i.e. why a mismatch is a safe MISS here rather than a
   *  silent wrong read, or a named gap this WO did not create and does not
   *  fix. */
  migration: string
  /** What this surface keeps vs. strips. 'entire record' for a surface with
   *  no field-level partialize; PROJECT_FIELD_TREATMENT above for the one
   *  surface (project-document) that has field-level classification. */
  keepList: string
}

export const PERSISTED_SURFACES: Record<PersistedSurfaceId, PersistedSurface> = {
  'project-document': {
    id: 'project-document',
    medium: 'zustand-persist-userspace',
    version: 'PERSIST_STORE_VERSION (store/index.ts) = 6 - the zustand-wrapper axis, independent of Project.schemaVersion (the .camproject file\'s own axis, currently CURRENT_PROJECT_SCHEMA_VERSION = 19, projectMigrations.ts).',
    migration: 'persistMigrate (store/index.ts) on the localStorage/userSpace rehydrate leg; migrateProjectData (projectMigrations.ts, which runs the schemaMigration.ts generic chain-runner) on the .camproject file-open leg. Both funnel a pre-v1 blob through migrateHierarchy.ts\'s migrateProjectToHierarchy. schemaMigration.ts\'s Migration<T>/runMigrationChain engine is already document-agnostic (its own header: "the generic substrate for the project-document chain and any future versioned document") - it is not fenced to Project, only currently used by it.',
    keepList: 'PROJECT_FIELD_TREATMENT above - the one table persistPartialize (localStorage leg) and packageProjectToFile (file leg, both in store/index.ts) read via omitProjectFields + stripOperationForPersistence.',
  },
  'ui-preferences': {
    id: 'ui-preferences',
    medium: 'zustand-persist-localstorage',
    version: 'UI_PREFS_VERSION (store/uiPrefs.ts)',
    migration: 'migrateUiPrefs (uiPrefs.ts): a real migrate function backfills the UI-34 default (workbenchCameraProjection) for any version < UI_PREFS_VERSION. A mismatch is not a miss here - it is actively healed, field-by-field, because UI prefs are cross-project and losing them on every version bump would be a real regression for a returning user.',
    keepList: 'entire record (whole-store persist via persistRegistered(\'uiPreferences\', ...), no partialize option).',
  },
  'machine-actions': {
    id: 'machine-actions',
    medium: 'zustand-persist-localstorage',
    version: '1 (machineActionsStore.ts, persistRegistered(\'machineActions\', ..., { version: 1 })), unbumped since inception.',
    migration: 'No migrate option. A mismatch would hit zustand\'s own no-migrate-provided path (console.error, no state applied) - undocumented and unexercised because the version has never moved. Named here as a gap for whoever next bumps this store\'s version, not fixed by WO-1818 (out of scope: no behaviour change).',
    keepList: 'entire record (whole-store persist, no partialize option). WO-1676 moved the tool-table/probe-override portion of this data onto MachineConfig itself (project-scoped, travels with the project/machine export); this store now covers only macros and park positions, per its own comment at persistedKeys.ts machineActions.holds.',
  },
  'machine-tool-table-legacy': {
    id: 'machine-tool-table-legacy',
    medium: 'zustand-persist-localstorage',
    version: 'n/a - WO-1676 stopped this key from being written by any live store; nothing persists to it anymore.',
    migration: 'None needed: read-only legacy data. The key stays registered in persistedKeys.ts (never removed - ADR-0040 governs project FILE formats, not a user\'s already-written localStorage) purely so UserDataStoragePanel can still back up and explain pre-WO-1676 installs\' data.',
    keepList: 'n/a (no active writer; historical shape only).',
  },
  'probe-routines': {
    id: 'probe-routines',
    medium: 'zustand-persist-localstorage',
    version: '1 (probeRoutineStore.ts, persistRegistered(\'probeRoutines\', ..., { version: 1, ... })).',
    migration: 'No migrate option, but every stored routine is re-validated through loadProbeRoutineLibrary on the merge step (probeRoutineStore.ts) regardless of version - one that no longer validates is quarantined WITH its failure reasons, never silently dropped (ADR-0040: no legacy migration path, ADR-0040 no-legacy-before-1.0 posture). A mismatch is therefore already a documented, tested miss (quarantine, not data loss).',
    keepList: 'partialize keeps { routines, quarantined, hidden } only (excludes derived/action state).',
  },
  'model-body-display-cache': {
    id: 'model-body-display-cache',
    medium: 'indexeddb',
    version: 'Per-record: ModelBodyRef.version, re-checked against the caller\'s current ref on every read (src/lib/modelBodyDisplayCache.ts).',
    migration: 'No schema migration - a version (or projectId/geometryId/bodyId) mismatch on read is a HIT-vs-MISS decision per record, not a whole-cache migration: a stale record is deleted on the way out and the caller\'s normal miss path (re-derive from the live Model workbench body) recovers it. Refuse-and-recover by construction, per the module\'s own R2 header comment (rule 1). Sibling caches (stlCache.ts, stepCache.ts, geometry2dCache.ts) follow the same mismatch-is-a-miss contract for their own payloads.',
    keepList: 'one ModelBodyDisplay per (projectId, geometryId) key; bounded by an explicit byte cap and entry cap, evicted oldest-written-first (LRW).',
  },
  'user-space-envelope': {
    id: 'user-space-envelope',
    medium: 'zustand-persist-userspace',
    version: 'STORAGE_SCHEMA_VERSION = 1 (store/userSpaceStorage.ts), stamped on both the GenerationEnvelope and GenerationPointer wrapper records - a DIFFERENT axis from project-document\'s PERSIST_STORE_VERSION: this is the OPFS/localStorage-mirror envelope format itself, not the project payload it carries.',
    migration: 'Not yet bumped since this envelope format shipped. A future bump needs its own migration step in userSpaceStorage.ts before this WO\'s registry entry can claim a tested mismatch policy - named here rather than silently assumed safe.',
    keepList: 'the generation payload is opaque at this layer (whatever the project-document leg above serializes into it); the envelope itself keeps { schema, schemaVersion, storageKey, generation, createdAt, checksum, payload } (GenerationEnvelope) / { schema, schemaVersion, storageKey, current, previous } (GenerationPointer) verbatim.',
  },
}
